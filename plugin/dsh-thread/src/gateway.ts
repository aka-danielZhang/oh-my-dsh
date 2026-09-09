import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-presets'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-api-session-controller/types'
import { SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-title'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-workspace'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-session-projection'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import z from '@deepseek-ai/schemastery'
import { randomBytes } from 'node:crypto'
import { threadDomainSpec } from './domain.ts'
import { isFinalThreadDraftReason, sealThreadDraftBoundary, type ThreadHandoffDraft } from './draft.ts'
import { advanceCreation, deriveThreadIdentity, resolveThreadId } from './identity.ts'
import { clearLegacyCapture, needsLegacyRewrite } from './migrate.ts'
import { checkDeliveryPresence, checkSemanticPurity, type PurityEvent } from './purity.ts'
import {
  DEFAULT_THREAD_SETTINGS,
  THREAD_SETTINGS_NAMESPACE,
  type ThreadModelSelection,
  type ThreadSettings,
  type ThreadLink,
  type TargetFingerprint,
} from './thread-types.ts'
import type {
  ActivateRequest,
  ActivateResult,
  AuthorizeRequest,
  AuthorizeResult,
  BeginCreationRequest,
  CloneResult,
  MutationResult,
  PresetListResult,
  RecordTitleRequest,
  ReconcileRequest,
  ReconcileResult,
  StateResult,
  ThreadDraftRecord,
} from './thread-types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    thread: ThreadGateway
  }
}

/**
 * Create-side error codes that no retry can fix: the deterministic target id
 * already exists with a different cwd/preset/workspace identity. Everything
 * else (network, internal, workspace hiccup) may simply be re-issued — the
 * idempotent create makes that safe. The recorded error carries the upstream
 * `code: message` shape, so matching is by code prefix.
 */
const TERMINAL_CREATE_CODES = [
  'session/conflict',
  'agent-preset/conflict',
  'session/workspace-attach-failed',
]

function isTerminalCreateError(recorded: string): boolean {
  return TERMINAL_CREATE_CODES.some(code => recorded === code || recorded.startsWith(`${code}:`))
}

/** Durable Thread settings schema; also the wire envelope the browser scope validates against. */
const ThreadSettingsSchema: z<ThreadSettings> = z.object({
  enabled: z.boolean().default(DEFAULT_THREAD_SETTINGS.enabled),
})

function copyLink(link: ThreadLink): ThreadLink {
  return structuredClone(link)
}

function copyDraft(draft: ThreadDraftRecord): ThreadDraftRecord {
  return structuredClone(draft)
}

function errorCode(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function fingerprintMatches(expected: TargetFingerprint, actual: TargetFingerprint): boolean {
  return expected.createdAt === actual.createdAt
    && expected.agentPreset === actual.agentPreset
    && expected.workspaceId === actual.workspaceId
    && expected.cwd === actual.cwd
}

function asPurityEvents(events: readonly SessionEvent[]): readonly PurityEvent[] {
  return events as unknown as readonly PurityEvent[]
}

/** Shared Host authority for direct-confirmation Thread activation. */
export class ThreadGateway extends TypertRemoteService {
  static inject = ['storageDomain', 'agents', 'sessions', 'agentPresets', 'workspaceRegistry', 'sessionProjections', 'llm']

  private draftTable?: KvTable<string, ThreadDraftRecord>
  private table?: KvTable<string, ThreadLink>
  private operationTail: Promise<void> = Promise.resolve()
  private accepting = true
  private enabled = DEFAULT_THREAD_SETTINGS.enabled
  private readonly enabledListeners = new Set<() => void>()

  constructor(ctx: Context) {
    super(ctx, 'thread')
  }

  /** Current Thread master switch; defaults on when no settings provider exists. */
  isEnabled(): boolean {
    return this.enabled
  }

  /** Observe master-switch flips (host-plane consumers: the tool row). */
  subscribeEnabled(listener: () => void): () => void {
    this.enabledListeners.add(listener)
    return () => { this.enabledListeners.delete(listener) }
  }

  private setEnabled(next: boolean): void {
    if (this.enabled === next) return
    this.enabled = next
    for (const listener of this.enabledListeners) listener()
  }

  protected async [Service.init](): Promise<void> {
    // The master switch lives in the settings document so the browser row and
    // every Host consumer share one durable fact. Without a settings provider
    // (headless compositions) the feature stays on.
    const settings = this.ctx.get('settings')
    if (settings !== undefined) {
      const scope = settings.register(THREAD_SETTINGS_NAMESPACE as SettingsNamespace, ThreadSettingsSchema)
      this.enabled = scope.get().enabled
      this.ctx.effect(() => scope.watch(next => { this.setEnabled(next.enabled) }), 'dsh-thread: settings watch')
    }
    const domain = await this.ctx.storageDomain.open(threadDomainSpec)
    this.draftTable = domain.table('drafts')
    this.table = domain.table('links')
    // One durable rewrite of legacy overloaded-state records. The table schema
    // already migrates them in memory on read; this clears the capture marker
    // so the work is exactly-once per record and the persisted form is clean.
    const now = Date.now()
    for (const [linkId, link] of this.requireTable().entries()) {
      if (needsLegacyRewrite(link)) await this.requireTable().put(linkId, clearLegacyCapture(link, now))
    }
    this.ctx.on('session/event', (session, event) => {
      void this.enqueue(async () => {
        if (event.type === 'turn/end') await this.reconcileDrafts(session)
        if ([...this.requireTable().entries()].some(([, link]) => link.targetSessionId === String(session.id))) {
          await this.foldEvent(String(session.id), event)
        }
      }).catch((error) => {
        this.ctx.logger('dsh-thread').error('failed to persist Thread projection', error)
      })
    })
    this.ctx.on('agent/session-start', ({ agent }) => {
      void this.enqueue(() => this.reconcileDrafts(agent.session)).catch((error) => {
        this.ctx.logger('dsh-thread').error('failed to reconcile Thread drafts', error)
      })
    })
    this.ctx.effect(() => async () => {
      this.accepting = false
      await this.operationTail
      await domain.close()
    }, 'dsh-thread.domainClose')
  }

  async prepareDraft(draft: ThreadHandoffDraft, callId: string): Promise<ThreadDraftRecord> {
    return await this.enqueue(async () => {
      const table = this.requireDraftTable()
      const existing = table.get(draft.draftId)
      if (existing !== undefined) return copyDraft(existing)
      const now = Date.now()
      const record: ThreadDraftRecord = {
        draftId: draft.draftId,
        version: draft.version,
        sourceSessionId: draft.sourceSessionId,
        sourceAnchor: { kind: 'tool-call', callId },
        sourceBoundarySeq: null,
        sourceTurn: null,
        status: 'waiting-boundary',
        handoff: {
          objective: draft.objective,
          confirmedConclusions: [...draft.confirmedConclusions],
          constraints: [...draft.constraints],
          openQuestions: [...draft.openQuestions],
          artifacts: draft.artifacts.map(artifact => ({ ...artifact })),
        },
        instruction: draft.nextInstruction,
        suggestedPreset: draft.suggestedPreset ?? null,
        targetTitle: draft.targetTitle ?? null,
        createdAt: now,
        updatedAt: now,
      }
      await table.put(record.draftId, record)
      return copyDraft(record)
    })
  }

  async presets(): Promise<PresetListResult> {
    const presets = await this.ctx.agentPresets.list()
    return {
      presets: presets.map(preset => ({
        id: preset.id,
        name: preset.name ?? null,
        broken: preset.broken ?? null,
        isDefault: preset.id === this.ctx.agentPresets.defaultId,
      })),
    }
  }

  authorize(request: AuthorizeRequest): Promise<AuthorizeResult> {
    return this.enqueue(async () => {
      if (!this.enabled) return { ok: false, error: 'thread-disabled' }
      const draft = await this.resolveAuthorizationDraft(request)
      if (typeof draft === 'string') return { ok: false, error: draft }
      const sourceSessionId = SessionId(request.sourceSessionId)
      const sourceWorkspace = this.ctx.workspaceRegistry.list().find(workspace => (
        workspace.sessionIds.includes(sourceSessionId)
      ))
      const sourceSession = this.ctx.sessions.get(sourceSessionId)
      if (sourceWorkspace === undefined && sourceSession === undefined) {
        return { ok: false, error: 'source-placement-unavailable' }
      }
      // The continuation inherits the source Session's own preset (falling
      // back to the deployment default): Thread no longer owns a mode.
      const targetPreset = sourceSession?.header.agentPreset ?? this.ctx.agentPresets.defaultId
      if (targetPreset === undefined) return { ok: false, error: 'source-preset-unavailable' }
      const preset = await this.ctx.agentPresets.resolve(targetPreset)
      if (preset.broken !== undefined) {
        return { ok: false, error: `preset-broken: ${preset.broken}` }
      }
      const targetWorkspaceId = sourceWorkspace === undefined ? null : String(sourceWorkspace.id)
      const targetCwd = sourceWorkspace === undefined ? sourceSession?.header.cwd ?? null : null
      // The continuation inherits the source Session's effective model
      // selection (a pending user pick, else the route actually used last).
      // The route is validated here so the confirmation panel never promises a
      // model that can no longer be served; failures are loud, not a silent
      // downgrade to the deployment default.
      const projection = sourceSession === undefined
        ? undefined
        : this.ctx.sessionProjections.stateOf(sourceSession, 'modelSelection')
      const selected = projection === undefined ? null : projection.pending ?? projection.lastUsed
      let model: ThreadModelSelection | null = null
      if (selected !== null) {
        try {
          const resolved = await this.ctx.llm.resolveCallConfig({
            provider: selected.provider,
            model: selected.model,
            ...(selected.reasoningEffort === undefined
              ? {}
              : { reasoningEffort: ReasoningEffortId(selected.reasoningEffort) }),
          })
          model = {
            provider: resolved.provider,
            model: resolved.model,
            ...(resolved.reasoningEffort === undefined ? {} : { reasoningEffort: String(resolved.reasoningEffort) }),
          }
        } catch {
          return { ok: false, error: `source-model-unavailable: ${selected.provider}/${selected.model}` }
        }
      }
      const table = this.requireTable()
      const identity = deriveThreadIdentity(request.draftId)
      const existing = table.get(identity.linkId)
        ?? [...table.entries()].find(([, link]) => link.draftId === request.draftId)?.[1]
      if (existing !== undefined) {
        if (!this.matchesAuthorization(existing, request)) return { ok: false, error: 'authorization-conflict' }
        return this.authorizationPlan(existing)
      }
      const thread = resolveThreadId(request.sourceSessionId, [...table.entries()].map(([, link]) => link))
      if (!thread.ok) return { ok: false, error: `${thread.error}: ${thread.threadIds.join(', ')}` }

      const now = Date.now()
      const link: ThreadLink = {
        linkId: identity.linkId,
        threadId: thread.threadId,
        sourceSessionId: request.sourceSessionId,
        targetSessionId: identity.targetSessionId,
        draftId: request.draftId,
        draftVersion: draft.version,
        authorizationActionId: request.actionId,
        creationActionId: null,
        targetWorkspaceId,
        targetCwd,
        agentPreset: targetPreset,
        model,
        target: { phase: 'reserved', fingerprint: null },
        title: {
          phase: request.title === undefined ? 'not-requested' : 'pending',
          requested: request.title ?? null,
          accepted: null,
          eventSeq: null,
          failure: null,
        },
        handoff: structuredClone(request.handoff),
        instruction: request.instruction,
        delivery: { phase: 'prepared', attempt: 0, handoffId: null, instructionId: null },
        relation: 'pending',
        relationCommit: null,
        failure: null,
        legacy: null,
        trace: [],
        fold: { splices: [], entries: [], turns: [], titles: [], models: [] },
        createdAt: now,
        updatedAt: now,
      }
      await table.put(link.linkId, link)
      return this.authorizationPlan(link)
    })
  }

  beginCreation(request: BeginCreationRequest): Promise<MutationResult> {
    return this.enqueue(async () => {
      const link = this.requireTable().get(request.linkId)
      if (link === undefined) return { ok: false, error: 'link-not-found' }
      const decision = advanceCreation(link, request.actionId, Date.now())
      if (!decision.ok) return { ok: false, error: decision.error, state: decision.phase }
      if (decision.changed) await this.requireTable().put(decision.link.linkId, decision.link)
      return { ok: true, link: copyLink(decision.link) }
    })
  }

  /**
   * Establish the `published` checkpoint by probing the deterministic target
   * id: a live agent yields header facts that are pinned as the target
   * fingerprint (exact-matched afterwards); no live agent means the client
   * should re-issue the idempotent create. An optional `createError` records
   * the structured create-side failure while the probe finds nothing.
   */
  reconcileTarget(request: ReconcileRequest): Promise<ReconcileResult> {
    return this.enqueue(async () => {
      const table = this.requireTable()
      let link = table.get(request.linkId)
      if (link === undefined) return { ok: false, error: 'link-not-found' }
      if (link.relation === 'active') return { ok: true, link: copyLink(link), next: 'none' }
      if (link.target.phase === 'diverged' || link.target.phase === 'abandoned') {
        return { ok: true, link: copyLink(link), next: 'none' }
      }
      const agent = this.ctx.agents.get(SessionId(link.targetSessionId))
      if (agent === undefined) {
        if (request.createError !== undefined && (link.target.phase === 'creating' || link.target.phase === 'reserved')) {
          const terminal = isTerminalCreateError(request.createError)
          const failed: ThreadLink = {
            ...link,
            failure: {
              phase: 'create',
              code: request.createError.slice(0, 300),
              recovery: terminal ? 'clone' : 'resume',
              detail: null,
            },
            updatedAt: Date.now(),
          }
          await table.put(failed.linkId, failed)
          return { ok: true, link: copyLink(failed), next: terminal ? 'none' : 'create' }
        }
        return { ok: true, link: copyLink(link), next: 'create' }
      }
      if (agent.session.header.createdAt < link.createdAt) {
        const diverged = await this.markIdentityConflict(link, 'target-created-before-authorization')
        return { ok: false, error: 'target-created-before-authorization', link: copyLink(diverged) }
      }
      const actual = this.fingerprintOf(agent)
      if (link.targetWorkspaceId !== null && actual.workspaceId === null) {
        // Workspace attach may still be pending inside an in-flight create;
        // the idempotent re-issue settles it. Never pin a transient null.
        return { ok: true, link: copyLink(link), next: 'create' }
      }
      if (link.target.fingerprint === null) {
        const published: ThreadLink = {
          ...link,
          target: { phase: 'published', fingerprint: actual },
          failure: null,
          trace: [...link.trace, { step: 'target-published', ok: true, detail: { ...actual } }],
          updatedAt: Date.now(),
        }
        const adopted = this.adoptTitleFromLog(published, agent)
        await table.put(adopted.linkId, adopted)
        return { ok: true, link: copyLink(adopted), next: 'none' }
      }
      if (!fingerprintMatches(link.target.fingerprint, actual)) {
        const diverged = await this.markIdentityConflict(link, 'target-identity-conflict')
        return { ok: false, error: 'target-identity-conflict', link: copyLink(diverged) }
      }
      const settled: ThreadLink = {
        ...link,
        target: { ...link.target, phase: 'published' },
        updatedAt: Date.now(),
      }
      const adopted = this.adoptTitleFromLog(settled, agent)
      if (adopted !== settled) await table.put(adopted.linkId, adopted)
      return { ok: true, link: copyLink(adopted), next: 'none' }
    })
  }

  /**
   * Record one rename outcome bound to the creation attempt that issued it.
   * `accepted` carries the authoritative normalized title and event seq from
   * the `session.rename` response; when the target is live the Host verifies
   * the referenced seq really is that `session/title` event instead of
   * trusting the client. Title failures never gate activation.
   */
  recordTitle(request: RecordTitleRequest): Promise<MutationResult> {
    return this.enqueue(async () => {
      const table = this.requireTable()
      const link = table.get(request.linkId)
      if (link === undefined) return { ok: false, error: 'link-not-found' }
      if (link.creationActionId === null || request.attempt !== link.creationActionId) {
        return { ok: false, error: 'cas-failed', state: link.target.phase }
      }
      if (link.title.phase === 'accepted') return { ok: true, link: copyLink(link) }
      const outcome = request.outcome
      const now = Date.now()
      if (outcome.kind === 'accepted') {
        const agent = this.ctx.agents.get(SessionId(link.targetSessionId))
        if (agent !== undefined) {
          const event = asPurityEvents(agent.session.events).find(item => item.seq === outcome.eventSeq)
          if (event?.type !== 'session/title' || (event.data as { title?: unknown }).title !== outcome.title) {
            const unknown: ThreadLink = {
              ...link,
              title: { ...link.title, phase: 'unknown', failure: 'title-verification-failed' },
              trace: [...link.trace, { step: 'title-verify', ok: false, detail: { eventSeq: outcome.eventSeq } }],
              updatedAt: now,
            }
            await table.put(unknown.linkId, unknown)
            return { ok: true, link: copyLink(unknown) }
          }
        }
        const accepted: ThreadLink = {
          ...link,
          title: {
            phase: 'accepted',
            requested: link.title.requested,
            accepted: outcome.title,
            eventSeq: outcome.eventSeq,
            failure: null,
          },
          trace: [...link.trace, {
            step: 'title-accepted',
            ok: true,
            detail: { eventSeq: outcome.eventSeq, verified: agent !== undefined },
          }],
          updatedAt: now,
        }
        await table.put(accepted.linkId, accepted)
        return { ok: true, link: copyLink(accepted) }
      }
      const recorded: ThreadLink = {
        ...link,
        title: {
          ...link.title,
          phase: outcome.kind === 'failed' ? 'failed' : 'unknown',
          failure: outcome.error.slice(0, 500),
        },
        trace: [...link.trace, { step: `title-${outcome.kind}`, ok: false, detail: { error: outcome.error } }],
        updatedAt: now,
      }
      await table.put(recorded.linkId, recorded)
      return { ok: true, link: copyLink(recorded) }
    })
  }

  /**
   * Deliver the Handoff into the published target under checkpointed
   * crash-recovery semantics:
   *
   * 1. fingerprint identity (pin-or-exact-match) and semantic purity —
   *    `session/title` events never count against purity;
   * 2. persist the `submitting` checkpoint WITH the message ids BEFORE the
   *    first inbox mutation, so every crash window is decidable by id
   *    presence in the target log;
   * 3. inject only the messages still missing, then flush;
   * 4. commit `relation: active` only after both messages are durable.
   *
   * An `uncertain` delivery refuses to run without an explicit
   * `redeliver` confirmation (the redelivery self-detects landed messages by
   * id and only re-sends what is missing, so it can never duplicate).
   */
  activate(request: ActivateRequest): Promise<ActivateResult> {
    return this.enqueue(async () => {
      const table = this.requireTable()
      const stored = table.get(request.linkId)
      if (stored === undefined) return { ok: false, error: 'link-not-found' }
      if (stored.relation === 'active') return { ok: true, link: copyLink(stored) }
      if (stored.target.phase === 'diverged') {
        return { ok: false, error: 'target-diverged', link: copyLink(stored) }
      }
      if (stored.target.phase === 'abandoned') return { ok: false, error: 'link-abandoned', link: copyLink(stored) }
      if (stored.target.phase !== 'published') {
        return { ok: false, error: `target-not-published:${stored.target.phase}`, link: copyLink(stored) }
      }
      if (stored.delivery.phase === 'uncertain' && request.redeliver !== true) {
        return { ok: false, error: 'delivery-uncertain', link: copyLink(stored) }
      }

      const agent = this.ctx.agents.get(SessionId(stored.targetSessionId))
      if (agent === undefined) return { ok: false, error: 'target-not-live', link: copyLink(stored) }

      // Fingerprint: pin on first activation-side observation (create has
      // provably succeeded by now), exact-match afterwards.
      const actual = this.fingerprintOf(agent)
      let link = stored
      if (link.target.fingerprint === null) {
        if (link.targetWorkspaceId !== null && actual.workspaceId === null) {
          return { ok: false, error: 'target-workspace-mismatch', link: copyLink(link) }
        }
        link = {
          ...link,
          target: { phase: 'published', fingerprint: actual },
          trace: [...link.trace, { step: 'target-fingerprint', ok: true, detail: { ...actual } }],
          updatedAt: Date.now(),
        }
        await table.put(link.linkId, link)
      } else if (!fingerprintMatches(link.target.fingerprint, actual)) {
        const diverged = await this.markIdentityConflict(link, 'target-identity-conflict')
        return { ok: false, error: 'target-identity-conflict', link: copyLink(diverged) }
      }

      const events = asPurityEvents(agent.session.events)
      // Title adoption: a rename response may have been lost (pending/unknown);
      // the target log's latest session/title is authoritative. Display-only,
      // so this never gates anything.
      const adopted = this.adoptTitleFromLog(link, agent)
      if (adopted !== link) {
        link = adopted
        await table.put(link.linkId, link)
      }

      const presence = checkDeliveryPresence(events, link.delivery.handoffId, link.delivery.instructionId)
      const midFlight = link.delivery.phase === 'submitting' || link.delivery.phase === 'uncertain'
      if (midFlight && presence.delivered) {
        // Our messages are in the log (flush landed before the crash, or the
        // uncertain flush actually succeeded): commit without injecting.
        return await this.commitDelivered(table, link, agent)
      }

      // Fresh (re)delivery: purity gates injection. Known ids exempt our own
      // partially-landed messages from the check.
      const known = new Set<string>()
      if (presence.handoffPresent && link.delivery.handoffId !== null) known.add(link.delivery.handoffId)
      if (presence.instructionPresent && link.delivery.instructionId !== null) known.add(link.delivery.instructionId)
      const purity = checkSemanticPurity(events, known)
      if (!purity.ok) {
        return await this.markDiverged(table, link, purity.offending)
      }
      if (agent.status !== 'idle') {
        return { ok: false, error: 'target-not-idle', link: copyLink(link) }
      }

      // Build both messages first (pure constructors mint the ids), then
      // persist the ids BEFORE any mutation — the durable pre-injection
      // checkpoint that makes every later crash window decidable.
      const handoff = presence.handoffPresent ? null : createUserMessage({
        content: [{ type: 'text', text: this.renderHandoff(link) }],
        source: {
          kind: 'plugin',
          plugin: 'dsh-thread',
          form: 'snapshot',
          sections: [
            { name: '目标', text: link.handoff.objective },
            { name: '已确认结论', text: link.handoff.confirmedConclusions.join('\n') },
            { name: '约束', text: link.handoff.constraints.join('\n') },
            { name: '待确认', text: link.handoff.openQuestions.join('\n') },
            ...(link.handoff.artifacts.length === 0 ? [] : [{
              name: '产物',
              text: link.handoff.artifacts.map(artifact => (
                `- ${artifact.label}${artifact.uri === null ? '' : ` (${artifact.uri})`}${artifact.summary === null ? '' : `：${artifact.summary}`}`
              )).join('\n'),
            }]),
          ],
        },
      })
      const instruction = presence.instructionPresent ? null : createUserMessage({
        content: [{ type: 'text', text: link.instruction }],
        source: { kind: 'user' },
      })
      const submitting: ThreadLink = {
        ...link,
        delivery: {
          phase: 'submitting',
          attempt: link.delivery.attempt + 1,
          handoffId: handoff === null ? link.delivery.handoffId : String(handoff.id),
          instructionId: instruction === null ? link.delivery.instructionId : String(instruction.id),
        },
        trace: [...link.trace, {
          step: 'delivery-checkpoint',
          ok: true,
          detail: {
            attempt: link.delivery.attempt + 1,
            ...(handoff === null ? {} : { handoffId: String(handoff.id) }),
            ...(instruction === null ? {} : { instructionId: String(instruction.id) }),
          },
        }],
        updatedAt: Date.now(),
      }
      await table.put(submitting.linkId, submitting)

      // Carry the source Session's model onto the target before the first
      // inbox mutation: a `model/selection` event folds into the durable
      // projection, so prompt assembly resolves it. Deliberately NOT
      // `sessionRemote.selectModel` — that path also rewrites the global
      // default model and effort memory, which inheritance must not do. The
      // append is synchronous (no await between the purity check and the
      // first inbox mutation) and idempotent for an identical selection.
      if (submitting.model !== null) {
        const selection = submitting.model
        const already = agent.session.events.some(event => (
          event.type === 'model/selection'
          && event.data.provider === selection.provider
          && event.data.model === selection.model
          && event.data.reasoningEffort === selection.reasoningEffort
        ))
        if (!already) agent.session.append('model/selection', structuredClone(selection))
      }
      if (handoff !== null) agent.inject(handoff)
      if (instruction !== null) agent.followup(instruction)

      try {
        const flushed = await this.ctx.sessions.flush(agent.session)
        if (!flushed) return await this.markUncertain(table, submitting, 'durability-unavailable')
      } catch (error) {
        return await this.markUncertain(table, submitting, `durability-unavailable:${errorCode(error)}`)
      }

      const now = Date.now()
      const active: ThreadLink = {
        ...submitting,
        delivery: { ...submitting.delivery, phase: 'flushed' },
        relation: 'active',
        relationCommit: { reason: 'activation-flushed', at: now },
        trace: [
          ...submitting.trace,
          ...(submitting.model === null
            ? []
            : [{
                step: 'model-selection',
                ok: true,
                detail: { provider: submitting.model.provider, model: submitting.model.model },
              }]),
          { step: 'inject', ok: true, detail: { messageId: submitting.delivery.handoffId } },
          { step: 'followup', ok: true, detail: { messageId: submitting.delivery.instructionId } },
          { step: 'flush', ok: true },
        ],
        updatedAt: now,
      }
      await table.put(active.linkId, active)
      return { ok: true, link: copyLink(active) }
    })
  }

  /** Clone one link's sealed content into a fresh Draft identity (new Draft id, hence new Link and target). */
  cloneDraft(request: { linkId: string }): Promise<CloneResult> {
    return this.enqueue(async () => {
      const table = this.requireTable()
      const link = table.get(request.linkId)
      if (link === undefined) return { ok: false, error: 'link-not-found' }
      const draftTable = this.requireDraftTable()
      const source = draftTable.get(link.draftId)
      const now = Date.now()
      const draftId = `${link.draftId}-clone-${now.toString(36)}-${randomBytes(4).toString('hex')}`
      const draft: ThreadDraftRecord = {
        draftId,
        version: 1,
        sourceSessionId: link.sourceSessionId,
        sourceAnchor: source?.sourceAnchor ?? { kind: 'latest-complete-turn' },
        sourceBoundarySeq: source?.sourceBoundarySeq ?? null,
        sourceTurn: source?.sourceTurn ?? null,
        status: 'editable',
        handoff: structuredClone(link.handoff),
        instruction: link.instruction,
        suggestedPreset: null,
        targetTitle: link.title.requested,
        createdAt: now,
        updatedAt: now,
      }
      await draftTable.put(draftId, draft)
      return { ok: true, draft: copyDraft(draft) }
    })
  }

  /** Cancel a not-yet-delivered authorization; the target (if any) stays a normal Session. */
  abandon(request: { linkId: string }): Promise<MutationResult> {
    return this.enqueue(async () => {
      const table = this.requireTable()
      const link = table.get(request.linkId)
      if (link === undefined) return { ok: false, error: 'link-not-found' }
      if (link.relation === 'active') return { ok: false, error: 'cas-failed', state: link.relation }
      if (link.delivery.phase !== 'prepared') return { ok: false, error: 'cas-failed', state: link.delivery.phase }
      const abandoned: ThreadLink = {
        ...link,
        target: { ...link.target, phase: 'abandoned' },
        relation: 'abandoned',
        failure: null,
        updatedAt: Date.now(),
      }
      await table.put(abandoned.linkId, abandoned)
      return { ok: true, link: copyLink(abandoned) }
    })
  }

  async state(): Promise<StateResult> {
    return {
      drafts: [...this.requireDraftTable().entries()].map(([, draft]) => copyDraft(draft)),
      links: [...this.requireTable().entries()].map(([, link]) => copyLink(link)),
    }
  }

  private async resolveAuthorizationDraft(request: AuthorizeRequest): Promise<ThreadDraftRecord | string> {
    const table = this.requireDraftTable()
    let draft = table.get(request.draftId)
    if (draft === undefined) {
      if (!request.draftId.startsWith(`header-${request.sourceSessionId}-`)) return 'draft-not-found'
      const agent = this.ctx.agents.get(SessionId(request.sourceSessionId))
      if (agent === undefined) return 'source-not-live'
      const boundary = agent.session.events.findLast(event => (
        event.type === 'turn/end' && isFinalThreadDraftReason(event.data.reason.kind)
      ))
      if (boundary?.type !== 'turn/end') return 'source-has-no-complete-turn'
      const now = Date.now()
      draft = {
        draftId: request.draftId,
        version: request.draftVersion,
        sourceSessionId: request.sourceSessionId,
        sourceAnchor: { kind: 'latest-complete-turn' },
        sourceBoundarySeq: boundary.seq,
        sourceTurn: boundary.data.turn,
        status: 'editable',
        handoff: structuredClone(request.handoff),
        instruction: request.instruction,
        suggestedPreset: null,
        targetTitle: request.title ?? null,
        createdAt: now,
        updatedAt: now,
      }
      await table.put(draft.draftId, draft)
    }
    if (draft.status === 'waiting-boundary') return 'source-turn-not-finalized'
    if (draft.status !== 'editable') return `draft-${draft.status}`
    if (draft.version !== request.draftVersion) return 'draft-version-conflict'
    if (draft.sourceSessionId !== request.sourceSessionId
      || draft.instruction !== request.instruction
      || draft.targetTitle !== (request.title ?? null)
      || JSON.stringify(draft.handoff) !== JSON.stringify(request.handoff)) {
      return 'draft-content-conflict'
    }
    return draft
  }

  private matchesAuthorization(link: ThreadLink, request: AuthorizeRequest): boolean {
    // The target preset is derived at first authorization and stays stamped on
    // the Link; re-confirmation is idempotent over the durable record.
    return link.sourceSessionId === request.sourceSessionId
      && link.draftVersion === request.draftVersion
      && link.title.requested === (request.title ?? null)
      && link.instruction === request.instruction
      && JSON.stringify(link.handoff) === JSON.stringify(request.handoff)
  }

  private authorizationPlan(link: ThreadLink): AuthorizeResult {
    return {
      ok: true,
      linkId: link.linkId,
      targetSessionId: link.targetSessionId,
      createPlan: {
        sessionId: link.targetSessionId,
        agentPreset: link.agentPreset,
        ...(link.targetWorkspaceId === null ? {} : { workspaceId: link.targetWorkspaceId }),
        ...(link.targetCwd === null ? {} : { cwd: link.targetCwd }),
      },
      ...(link.title.requested === null
        ? {}
        : { titlePlan: { sessionId: link.targetSessionId, title: link.title.requested } }),
    }
  }

  private fingerprintOf(agent: Agent): TargetFingerprint {
    const header = agent.session.header
    const workspace = this.ctx.workspaceRegistry.list().find(item => item.sessionIds.includes(agent.session.id))
    return {
      createdAt: header.createdAt,
      agentPreset: header.agentPreset ?? null,
      workspaceId: workspace === undefined ? null : String(workspace.id),
      cwd: header.cwd ?? null,
    }
  }

  /**
   * Adopt the authoritative title for a pending/unknown title saga from the
   * target log's latest `session/title` event. Never touches accepted/failed
   * phases; returns the same link when there is nothing to adopt.
   */
  private adoptTitleFromLog(link: ThreadLink, agent: Agent): ThreadLink {
    if (link.title.phase !== 'pending' && link.title.phase !== 'unknown') return link
    const titles = asPurityEvents(agent.session.events)
      .filter(event => event.type === 'session/title') as Array<PurityEvent & { data: { title: string } }>
    const last = titles[titles.length - 1]
    if (last === undefined) return link
    return {
      ...link,
      title: {
        phase: 'accepted',
        requested: link.title.requested,
        accepted: last.data.title,
        eventSeq: last.seq,
        failure: null,
      },
      trace: [...link.trace, { step: 'title-adopted', ok: true, detail: { eventSeq: last.seq } }],
      updatedAt: Date.now(),
    }
  }

  private async markIdentityConflict(link: ThreadLink, code: string): Promise<ThreadLink> {
    const diverged: ThreadLink = {
      ...link,
      target: { ...link.target, phase: 'diverged' },
      failure: { phase: 'create', code, recovery: 'clone', detail: null },
      trace: [...link.trace, { step: code, ok: false, detail: { fingerprint: link.target.fingerprint } }],
      updatedAt: Date.now(),
    }
    await this.requireTable().put(diverged.linkId, diverged)
    return diverged
  }

  private async markDiverged(
    table: KvTable<string, ThreadLink>,
    link: ThreadLink,
    offending: string,
  ): Promise<ActivateResult> {
    const diverged: ThreadLink = {
      ...link,
      target: { ...link.target, phase: 'diverged' },
      failure: { phase: 'activate', code: 'target-diverged', recovery: 'open-target', detail: { offending } },
      trace: [...link.trace, { step: 'target-diverged', ok: false, detail: { offending } }],
      updatedAt: Date.now(),
    }
    await table.put(diverged.linkId, diverged)
    return { ok: false, error: 'target-diverged', link: copyLink(diverged) }
  }

  private async markUncertain(
    table: KvTable<string, ThreadLink>,
    link: ThreadLink,
    code: string,
  ): Promise<ActivateResult> {
    const uncertain: ThreadLink = {
      ...link,
      delivery: { ...link.delivery, phase: 'uncertain' },
      failure: { phase: 'flush', code: code.slice(0, 300), recovery: 'resume', detail: null },
      trace: [...link.trace, { step: 'flush', ok: false, detail: { failure: code } }],
      updatedAt: Date.now(),
    }
    await table.put(uncertain.linkId, uncertain)
    return { ok: false, error: code, link: copyLink(uncertain) }
  }

  private async commitDelivered(
    table: KvTable<string, ThreadLink>,
    link: ThreadLink,
    agent: Agent,
  ): Promise<ActivateResult> {
    try {
      const flushed = await this.ctx.sessions.flush(agent.session)
      if (!flushed) return await this.markUncertain(table, link, 'durability-unavailable')
    } catch (error) {
      return await this.markUncertain(table, link, `durability-unavailable:${errorCode(error)}`)
    }
    const now = Date.now()
    const active: ThreadLink = {
      ...link,
      delivery: { ...link.delivery, phase: 'flushed' },
      relation: 'active',
      relationCommit: { reason: 'activation-flushed', at: now },
      trace: [...link.trace, { step: 'delivery-reconciled', ok: true }, { step: 'flush', ok: true }],
      updatedAt: now,
    }
    await table.put(active.linkId, active)
    return { ok: true, link: copyLink(active) }
  }

  private async reconcileDrafts(session: Session): Promise<void> {
    const table = this.requireDraftTable()
    const sourceSessionId = String(session.id)
    for (const [draftId, draft] of table.entries()) {
      if (draft.sourceSessionId !== sourceSessionId || draft.status !== 'waiting-boundary') continue
      const next = sealThreadDraftBoundary(draft, session.events, Date.now())
      if (next !== draft) await table.put(draftId, next)
    }
  }

  private async foldEvent(targetSessionId: string, event: SessionEvent): Promise<void> {
    const table = this.requireTable()
    const found = [...table.entries()].find(([, link]) => link.targetSessionId === targetSessionId)
    if (found === undefined) return
    const [linkId, link] = found
    const fold = structuredClone(link.fold)
    if (event.type === 'agent/inbox/spliced') {
      fold.splices.push({
        seq: event.seq,
        target: event.data.target,
        start: event.data.start,
        removedCount: event.data.removedCount ?? null,
        insertedIds: event.data.inserted.map(message => String(message.id)),
        outcome: event.data.outcome ?? null,
      })
    } else if (event.type === 'user/message') {
      fold.entries.push({ seq: event.seq, id: String(event.data.id) })
    } else if (event.type === 'turn/start' || event.type === 'turn/end') {
      fold.turns.push({ seq: event.seq, type: event.type })
    } else if (event.type === 'session/title') {
      fold.titles.push({ seq: event.seq, title: event.data.title })
    } else if (event.type === 'model/selection') {
      fold.models.push({
        seq: event.seq,
        provider: event.data.provider,
        model: event.data.model,
        ...(event.data.reasoningEffort === undefined ? {} : { reasoningEffort: event.data.reasoningEffort }),
      })
    } else {
      return
    }
    await table.put(linkId, { ...link, fold, updatedAt: Date.now() })
  }

  private renderHandoff(link: ThreadLink): string {
    const sections = [`目标：${link.handoff.objective}`]
    if (link.handoff.confirmedConclusions.length > 0) {
      sections.push(`已确认结论：\n${link.handoff.confirmedConclusions.map(item => `- ${item}`).join('\n')}`)
    }
    if (link.handoff.constraints.length > 0) {
      sections.push(`约束：\n${link.handoff.constraints.map(item => `- ${item}`).join('\n')}`)
    }
    if (link.handoff.openQuestions.length > 0) {
      sections.push(`待确认：\n${link.handoff.openQuestions.map(item => `- ${item}`).join('\n')}`)
    }
    if (link.handoff.artifacts.length > 0) {
      sections.push(`产物：\n${link.handoff.artifacts.map(artifact => (
        `- ${artifact.label}${artifact.uri === null ? '' : ` (${artifact.uri})`}${artifact.summary === null ? '' : `：${artifact.summary}`}`
      )).join('\n')}`)
    }
    return sections.join('\n\n')
  }

  private requireDraftTable(): KvTable<string, ThreadDraftRecord> {
    if (this.draftTable === undefined) throw new Error('dsh-thread: draft storage is not ready')
    return this.draftTable
  }

  private requireTable(): KvTable<string, ThreadLink> {
    if (this.table === undefined) throw new Error('dsh-thread: storage domain is not ready')
    return this.table
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.accepting) return Promise.reject(new Error('dsh-thread: service is disposing'))
    const result = this.operationTail.then(operation)
    this.operationTail = result.then(() => undefined, () => undefined)
    return result
  }
}

export default ThreadGateway
