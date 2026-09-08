import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-presets'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-title'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-workspace'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import z from '@deepseek-ai/schemastery'
import { threadDomainSpec } from './domain.ts'
import { isFinalThreadDraftReason, sealThreadDraftBoundary, type ThreadHandoffDraft } from './draft.ts'
import { advanceCreation, deriveThreadIdentity, resolveThreadId } from './identity.ts'
import {
  DEFAULT_THREAD_SETTINGS,
  THREAD_SETTINGS_NAMESPACE,
  type ThreadSettings,
} from './thread-types.ts'
import type {
  ActivateResult,
  AuthorizeRequest,
  AuthorizeResult,
  BeginCreationRequest,
  LinkRequest,
  MutationResult,
  PresetListResult,
  RecordTitleRequest,
  StateResult,
  ThreadDraftRecord,
  ThreadLink,
} from './thread-types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    thread: ThreadGateway
  }
}

const FORBIDDEN_PRISTINE_EVENTS = new Set([
  'turn/start',
  'user/message',
  'assistant/message',
  'assistant/chunk',
  'tool/call',
  'tool/result',
  'agent/inbox/spliced',
  'command/run',
])

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

/** Shared Host authority for direct-confirmation Thread activation. */
export class ThreadGateway extends TypertRemoteService {
  static inject = ['storageDomain', 'agents', 'sessions', 'agentPresets', 'workspaceRegistry']

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
        title: request.title ?? null,
        handoff: structuredClone(request.handoff),
        instruction: request.instruction,
        state: 'authorized',
        titleState: request.title === undefined ? 'not-requested' : 'pending',
        attempt: { phase: 'prepared', handoffId: null, instructionId: null },
        relationCommit: null,
        failure: null,
        trace: [],
        fold: { splices: [], entries: [], turns: [], titles: [] },
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
      if (!decision.ok) return { ok: false, error: decision.error, state: decision.state }
      if (decision.changed) await this.requireTable().put(decision.link.linkId, decision.link)
      return { ok: true, link: copyLink(decision.link) }
    })
  }

  recordTitle(request: RecordTitleRequest): Promise<MutationResult> {
    return this.enqueue(async () => {
      const link = this.requireTable().get(request.linkId)
      if (link === undefined) return { ok: false, error: 'link-not-found' }
      if (link.state !== 'creating') return { ok: false, error: 'cas-failed', state: link.state }
      const next = {
        ...link,
        titleState: request.ok ? 'applied' as const : 'failed' as const,
        updatedAt: Date.now(),
      }
      await this.requireTable().put(next.linkId, next)
      return { ok: true, link: copyLink(next) }
    })
  }

  activate(request: LinkRequest): Promise<ActivateResult> {
    return this.enqueue(async () => {
      const table = this.requireTable()
      const stored = table.get(request.linkId)
      if (stored === undefined) return { ok: false, error: 'link-not-found' }
      if (stored.state === 'active') return { ok: true, link: copyLink(stored) }
      if (stored.state !== 'creating') return { ok: false, error: `cas-failed:${stored.state}`, link: copyLink(stored) }

      const firstCheck = this.checkTarget(stored)
      if (!firstCheck.ok) return await this.fail(stored, firstCheck.error, firstCheck.detail)

      const submitting: ThreadLink = {
        ...stored,
        state: 'activating',
        attempt: { phase: 'submitting', handoffId: null, instructionId: null },
        trace: [...stored.trace, ...firstCheck.trace],
        updatedAt: Date.now(),
      }
      await table.put(submitting.linkId, submitting)

      // Re-resolve after the durable checkpoint. No await occurs between this
      // final live/idle/pristine check and the first inbox mutation.
      const finalCheck = this.checkTarget(submitting)
      if (!finalCheck.ok) return await this.fail(submitting, finalCheck.error, finalCheck.detail)
      const agent = finalCheck.agent
      const handoff = createUserMessage({
        content: [{ type: 'text', text: this.renderHandoff(submitting) }],
        source: {
          kind: 'plugin',
          plugin: 'dsh-thread',
          form: 'snapshot',
          sections: [
            { name: '目标', text: submitting.handoff.objective },
            { name: '已确认结论', text: submitting.handoff.confirmedConclusions.join('\n') },
            { name: '约束', text: submitting.handoff.constraints.join('\n') },
            { name: '待确认', text: submitting.handoff.openQuestions.join('\n') },
            ...(submitting.handoff.artifacts.length === 0 ? [] : [{
              name: '产物',
              text: submitting.handoff.artifacts.map(artifact => (
                `- ${artifact.label}${artifact.uri === null ? '' : ` (${artifact.uri})`}${artifact.summary === null ? '' : `：${artifact.summary}`}`
              )).join('\n'),
            }]),
          ],
        },
      })
      const instruction = createUserMessage({
        content: [{ type: 'text', text: submitting.instruction }],
        source: { kind: 'user' },
      })
      agent.inject(handoff)
      agent.followup(instruction)

      const submitted: ThreadLink = {
        ...submitting,
        attempt: { phase: 'submitting', handoffId: String(handoff.id), instructionId: String(instruction.id) },
        trace: [
          ...submitting.trace,
          { step: 'inject', ok: true, detail: { messageId: String(handoff.id) } },
          { step: 'followup', ok: true, detail: { messageId: String(instruction.id) } },
        ],
        updatedAt: Date.now(),
      }
      try {
        const flushed = await this.ctx.sessions.flush(agent.session)
        if (!flushed) return await this.uncertain(submitted, 'durability-unavailable')
      } catch (error) {
        return await this.uncertain(submitted, `durability-unavailable:${errorCode(error)}`)
      }

      const now = Date.now()
      const active: ThreadLink = {
        ...submitted,
        state: 'active',
        attempt: { ...submitted.attempt, phase: 'flushed' },
        relationCommit: { reason: 'activation-flushed', at: now },
        trace: [...submitted.trace, { step: 'flush', ok: true }],
        updatedAt: now,
      }
      await table.put(active.linkId, active)
      return { ok: true, link: copyLink(active) }
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
      const boundary = agent.session.snapshotEvents().findLast(event => (
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
      && link.title === (request.title ?? null)
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
      ...(link.title === null
        ? {}
        : { titlePlan: { sessionId: link.targetSessionId, title: link.title } }),
    }
  }

  private async reconcileDrafts(session: Session): Promise<void> {
    const table = this.requireDraftTable()
    const sourceSessionId = String(session.id)
    for (const [draftId, draft] of table.entries()) {
      if (draft.sourceSessionId !== sourceSessionId || draft.status !== 'waiting-boundary') continue
      const next = sealThreadDraftBoundary(draft, session.snapshotEvents(), Date.now())
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
    } else {
      return
    }
    await table.put(linkId, { ...link, fold, updatedAt: Date.now() })
  }

  private checkTarget(link: ThreadLink):
    | { ok: true; agent: Agent; trace: ThreadLink['trace'] }
    | { ok: false; error: string; detail: Record<string, unknown> } {
    const agent = this.ctx.agents.get(SessionId(link.targetSessionId))
    if (agent === undefined) return { ok: false, error: 'target-not-live', detail: {} }
    if (agent.status !== 'idle') {
      return { ok: false, error: 'target-not-idle', detail: { status: agent.status } }
    }
    if (link.targetWorkspaceId !== null) {
      const workspace = this.ctx.workspaceRegistry.list().find(item => String(item.id) === link.targetWorkspaceId)
      if (workspace === undefined || !workspace.sessionIds.includes(agent.session.id)) {
        return {
          ok: false,
          error: 'target-workspace-mismatch',
          detail: { expectedWorkspaceId: link.targetWorkspaceId },
        }
      }
    } else if (link.targetCwd !== null && agent.session.header.cwd !== link.targetCwd) {
      return {
        ok: false,
        error: 'target-workspace-mismatch',
        detail: { expectedCwd: link.targetCwd, actualCwd: agent.session.header.cwd ?? null },
      }
    }
    const events = agent.session.snapshotEvents()
    const counts: Record<string, number> = {}
    for (const event of events) counts[event.type] = (counts[event.type] ?? 0) + 1
    for (const type of FORBIDDEN_PRISTINE_EVENTS) {
      if ((counts[type] ?? 0) > 0) return { ok: false, error: 'target-not-pristine', detail: { offending: type } }
    }
    const titles = events.filter(event => event.type === 'session/title')
    if (link.titleState === 'applied') {
      const title = titles[0]
      if (titles.length !== 1 || title?.type !== 'session/title' || title.data.title !== link.title) {
        return { ok: false, error: 'target-not-pristine', detail: { offending: 'session/title' } }
      }
    } else if (titles.length !== 0) {
      return { ok: false, error: 'target-not-pristine', detail: { offending: 'session/title-unexpected' } }
    }
    return {
      ok: true,
      agent,
      trace: [
        { step: 'agent-live', ok: true },
        { step: 'agent-idle', ok: true },
        {
          step: 'target-workspace',
          ok: true,
          detail: link.targetWorkspaceId === null
            ? { cwd: link.targetCwd }
            : { workspaceId: link.targetWorkspaceId },
        },
        { step: 'target-pristine', ok: true, detail: { counts } },
      ],
    }
  }

  private async fail(
    link: ThreadLink,
    failure: string,
    detail: Record<string, unknown>,
  ): Promise<ActivateResult> {
    const failed: ThreadLink = {
      ...link,
      state: 'failed',
      failure,
      trace: [...link.trace, { step: failure, ok: false, detail }],
      updatedAt: Date.now(),
    }
    await this.requireTable().put(failed.linkId, failed)
    return { ok: false, error: failure, link: copyLink(failed) }
  }

  private async uncertain(link: ThreadLink, failure: string): Promise<ActivateResult> {
    const uncertain: ThreadLink = {
      ...link,
      state: 'uncertain',
      failure,
      attempt: { ...link.attempt, phase: 'uncertain' },
      trace: [...link.trace, { step: 'flush', ok: false, detail: { failure } }],
      updatedAt: Date.now(),
    }
    await this.requireTable().put(uncertain.linkId, uncertain)
    return { ok: false, error: failure, link: copyLink(uncertain) }
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
