/**
 * The task run's Agent Session (design §8.4, revised 2026-09-11: one task
 * owns ONE long-lived session). Three entry states share one transaction:
 * - `sessionId: null` — first run: create the session (webhook posture:
 *   preflight, create with preset mounted, attach workspace → permission
 *   preset → title → instruction as one plugin-origin message; failures roll
 *   back with detach + dispose).
 * - session live in this process — reattach to the bare agent, reapply
 *   permission preset + title, submit the instruction.
 * - session persisted but not live — `agents.resume` loads it (workspace
 *   attachment and plugins come from persistence), reapply preset + title,
 *   submit. The resumed handle is owned by this run and disposed at settle.
 *
 * The session id is decided at claim time (minted for a first run, the bound
 * id afterwards) so a crash at any point attributes the same session in the
 * durable audit. Instruction never enters logs, job labels, or error details.
 * @module dsh-scheduled-tasks/launch
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AgentHandle, ModelSelection } from '@deepseek-ai/dsh-agent'
import { createUserMessage, boundContextSummary, type LlmCallConfig } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-session-title'
import type {} from '@deepseek-ai/dsh-workspace'

/** Everything the transaction needs, pre-fenced by the caller. */
export interface TaskLaunchRequest {
  taskId: string
  runId: string
  /** The session this task is bound to; `null` creates it on this run. */
  sessionId: string | null
  /** Full session title, e.g. `[定时] 每日检查 · 02:00`. */
  title: string
  instruction: string
  workspacePath: string
  agentPreset: string
  permissionPreset: string
  /** `null` resolves the harness default selection at launch time. */
  model: { provider: string, model: string, reasoningEffort?: string } | null
}

/**
 * The submitted session plus the minimal agent face the run lifecycle needs.
 * `ownedHandle` is set only when this call created or resumed the agent — the
 * caller disposes it at settle; a live reattach never disposes someone else's
 * handle.
 */
export interface TaskLaunchHandle {
  sessionId: SessionId
  agent: TaskAgentView
  ownedHandle: AgentHandle | null
}

/** Structural view of the live agent used by the run lifecycle. */
export interface TaskAgentView {
  followup(message: unknown): void
  whenIdle(): Promise<void>
  session: unknown
}

/** Structural view of the agents registry actually used here. */
interface AgentsView {
  get(id: SessionId): TaskAgentView | undefined
  create(options: {
    sessionId: SessionId
    signal?: AbortSignal
    meta?: { cwd?: string, agentPreset?: string }
    agentOptions?: { provider: string, model: string, reasoningEffort?: string, maxTokens?: number }
    setup?: (agentCtx: Context) => unknown | Promise<unknown>
  }): Promise<AgentHandle>
  resume(options: {
    resumeSessionId: SessionId
    signal?: AbortSignal
    agentOptions?: { provider: string, model: string, reasoningEffort?: string, maxTokens?: number }
    setup?: (agentCtx: Context) => unknown | Promise<unknown>
  }): Promise<AgentHandle>
}

/** Structural view of the workspace registry actually used here. */
interface WorkspaceView {
  path: string
  attachSession(sessionId: SessionId): Promise<void>
  detachSession(sessionId: SessionId): Promise<void>
}

interface WorkspaceRegistryView {
  create(path: string): Promise<WorkspaceView>
}

/** Structural view of the agent-presets service actually used here. */
interface AgentPresetsView {
  resolve(id?: string): Promise<{ id: string }>
  standingKeyFor(id?: string): Promise<unknown>
  mount(agentCtx: Context, id?: string): Promise<unknown>
}

/** Structural view of the permission-presets service actually used here. */
interface PermissionPresetsView {
  resolve(name: string): unknown
  set(session: unknown, name: string): void
}

/** Structural view of the session-title service actually used here. */
interface SessionTitleView {
  rename(session: unknown, title: string): unknown
}

/** Structural view of the default-model service actually used here. */
interface AgentDefaultModelView {
  currentSelection(): ModelSelection
}

/** Structural view of the llm runtime actually used here. */
interface LlmView {
  resolveCallConfig(config: { provider: string, model: string, reasoningEffort?: string }): Promise<unknown>
}

/**
 * Apply the creation-time selection until the session's first durable request
 * header exists (webhook posture): a matching route has its inherited effort
 * replaced by the pinned one, and later user-initiated switches are untouched.
 */
function installInitialModelSelection(agentCtx: Context, selection: ModelSelection): void {
  agentCtx.on('agent/request', async ({ agent }, next): Promise<LlmCallConfig> => {
    const resolved = await next()
    if (agent.session.requestHeader() !== undefined
      || resolved.provider !== selection.provider
      || resolved.model !== selection.model) return resolved
    const { reasoningEffort: _inheritedEffort, ...withoutInheritedEffort } = resolved
    return {
      ...withoutInheritedEffort,
      ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
    }
  })
}

/**
 * Preflight and launch one ordinary root Session for the task run. Throws
 * before any durable side effect when a pinned workspace / preset / route
 * is unavailable (design §7: fail loud, never silently substitute).
 */
export async function launchTaskSession(ctx: Context, request: TaskLaunchRequest, signal: AbortSignal): Promise<TaskLaunchHandle> {
  // ---- preflight: every failure here costs nothing to roll back ----
  const permissionPresets = ctx.get('permissionPresets') as PermissionPresetsView | undefined
  const agentPresets = ctx.get('agentPresets') as AgentPresetsView | undefined
  const workspaceRegistry = ctx.get('workspaceRegistry') as WorkspaceRegistryView | undefined
  const sessionTitle = ctx.get('sessionTitle') as SessionTitleView | undefined
  const agentDefaultModel = ctx.get('agentDefaultModel') as AgentDefaultModelView | undefined
  const llm = ctx.get('llm') as LlmView | undefined
  const agents = ctx.get('agents') as AgentsView | undefined
  if (permissionPresets === undefined || agentPresets === undefined || workspaceRegistry === undefined
    || sessionTitle === undefined || agentDefaultModel === undefined || llm === undefined || agents === undefined) {
    throw new Error('scheduled-tasks: runtime session services are not mounted')
  }

  permissionPresets.resolve(request.permissionPreset)
  const preset = await agentPresets.resolve(request.agentPreset)
  await agentPresets.standingKeyFor(preset.id)
  signal.throwIfAborted()

  // Model: pinned route verified verbatim; the default selection is resolved
  // and verified as a complete selection at run time (design §7).
  const selection: ModelSelection = request.model === null
    ? agentDefaultModel.currentSelection()
    : {
      provider: request.model.provider,
      model: request.model.model,
      ...(request.model.reasoningEffort === undefined ? {} : { reasoningEffort: request.model.reasoningEffort as ModelSelection['reasoningEffort'] }),
    }
  await llm.resolveCallConfig({
    provider: selection.provider,
    model: selection.model,
    ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
  })
  const agentOptions = {
    provider: selection.provider,
    model: selection.model,
  }

  const message = createUserMessage({
    content: [{ type: 'text', text: request.instruction }],
    source: {
      kind: 'scheduled-task',
      taskId: request.taskId,
      form: 'notice',
      summary: boundContextSummary(`定时任务「${request.title}」触发执行`),
    },
  })

  // ---- first run: create the session this task will keep ----
  if (request.sessionId === null) {
    const workspace = await workspaceRegistry.create(request.workspacePath)
    signal.throwIfAborted()

    const sessionId = brandString<SessionId>(request.runId)
    const handle = await agents.create({
      sessionId,
      signal,
      meta: { cwd: workspace.path, agentPreset: preset.id },
      agentOptions,
      setup: async (agentCtx) => {
        await agentPresets.mount(agentCtx, preset.id)
        installInitialModelSelection(agentCtx, selection)
      },
    })

    // ---- post-attach assembly; failures roll the session back ----
    let attached = false
    try {
      signal.throwIfAborted()
      await workspace.attachSession(sessionId)
      attached = true
      signal.throwIfAborted()
      permissionPresets.set(handle.agent.session, request.permissionPreset)
      sessionTitle.rename(handle.agent.session, request.title)
      handle.agent.followup(message)
    } catch (error: unknown) {
      if (attached) {
        try {
          await workspace.detachSession(sessionId)
        } catch (rollbackError) {
          ctx.logger.warn(`scheduled-tasks: workspace detach rollback failed: ${String(rollbackError)}`)
        }
      }
      try {
        await handle.dispose()
      } catch (rollbackError) {
        ctx.logger.warn(`scheduled-tasks: agent dispose rollback failed: ${String(rollbackError)}`)
      }
      throw error
    }
    return { sessionId, agent: handle.agent, ownedHandle: handle }
  }

  // ---- bound session: reattach the live agent or resume the persisted one ----
  const sessionId = brandString<SessionId>(request.sessionId)
  const live = agents.get(sessionId)
  if (live !== undefined) {
    permissionPresets.set(live.session, request.permissionPreset)
    sessionTitle.rename(live.session, request.title)
    return { sessionId, agent: live, ownedHandle: null }
  }
  const handle = await agents.resume({
    resumeSessionId: sessionId,
    signal,
    agentOptions,
  })
  permissionPresets.set(handle.agent.session, request.permissionPreset)
  sessionTitle.rename(handle.agent.session, request.title)
  return { sessionId, agent: handle.agent, ownedHandle: handle }
}

/** Fresh run/session id pair minted at claim time. */
export function mintRunIds(): { runId: string, sessionId: string } {
  const uuid = randomUUID()
  return { runId: `task-${uuid}`, sessionId: `sched-${uuid}` }
}
