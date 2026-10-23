/**
 * Delegated background tasks: the main conversation hands work to a child
 * DSH session and gets a result back through the SAME notification outbox used
 * for proactive reports (one delivery channel, one set of quiet-hours/dedupe
 * rules).
 *
 * v1 capability boundary: the child runs the read-only `quno-task` preset.
 * Outward writes wait for a future approval surface.
 *
 * @module dsh-quno/tasks
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { newId, sha256, truncateText } from './util.ts'
import type { QunoStore } from './store.ts'
import type { HistoryReader, SessionEventLike } from './outbox.ts'
import type { NoticePayload, TaskArtifact, TaskRecord } from './types.ts'

/** Read-only child preset id registered by this plugin. */
export const TASK_PRESET = 'quno-task'

/** Minimal subagent activation shape (the real service conforms). */
export interface ActivationFace {
  readonly childId: string
  readonly messageId?: string
  readonly result: Promise<{
    readonly output: readonly unknown[]
    readonly stopReason: string
    readonly diagnostic?: string
  }>
  dispose(): Promise<void>
}

/** Minimal startActivation spec accepted by the real service. */
export interface ActivationRequest {
  readonly provider: string
  readonly label: string
  readonly childId?: string
  readonly request: {
    readonly prompt: readonly { readonly type: 'text'; readonly text: string }[]
    readonly cwd?: string
    readonly agentPreset?: string
    readonly maxDepth?: number
    readonly parent: Agent
  }
  readonly signal: AbortSignal
  readonly delivery: 'caller'
}

/** Minimal subagent runtime face. */
export interface SubagentsFace {
  startActivation(request: ActivationRequest): Promise<ActivationFace>
  sendMessage(sender: Agent, targetId: string, content: readonly unknown[], options: { readonly signal: AbortSignal }): Promise<string>
}

/** Minimal job outcome. */
export interface TaskJobOutcome {
  readonly status: 'completed' | 'failed' | 'killed'
  readonly detail?: string
  readonly result?: string
}

/** Minimal job runtime face. */
export interface JobsFace {
  start(spec: {
    readonly kind: string
    readonly label: string
    readonly owner?: string
    readonly outputLimitBytes?: number
    readonly run: () => {
      readonly cancel: (reason?: string) => void
      readonly done: Promise<TaskJobOutcome>
    }
  }): unknown
}

/** Task orchestration dependencies. */
export interface TaskDeps {
  readonly store: QunoStore
  readonly qunoId: string
  readonly subagents?: SubagentsFace
  readonly jobs?: JobsFace
  readonly history?: HistoryReader
  readonly logger: { warn: (message: string) => void; info?: (message: string) => void }
  readonly defaultCwd: string
  readonly now?: () => number
  /** Called after a task row changes (UI refresh). */
  readonly onChange?: () => void
  /** Called when a task settles and a notice should be delivered. */
  readonly onNotice?: () => void
}

/** Input the model-facing tool supplies. */
export interface StartTaskInput {
  readonly title: string
  readonly prompt: string
  readonly cwd?: string
  readonly parent: Agent
}

/** A refused task start. */
export class TaskError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'TaskError'
  }
}

/** Create, settle, reconcile and resume delegated tasks. */
export class TaskOrchestrator {
  private readonly now: () => number
  private readonly lifecycle = new AbortController()
  private readonly active = new Map<string, ActivationFace>()

  constructor(private readonly deps: TaskDeps) {
    this.now = deps.now ?? (() => Date.now())
  }

  /** Abort in-flight activations (plugin unload). Durable rows stay `running` for reconciliation. */
  stop(): void {
    this.lifecycle.abort(new Error('quno plugin unloading'))
  }

  /**
   * Start one delegated task and return immediately.
   * @throws {TaskError} when the runtime cannot start the child at all.
   */
  async start(input: StartTaskInput): Promise<TaskRecord> {
    if (this.deps.subagents === undefined) {
      throw new TaskError('unavailable', '委派子任务需要 subagent 运行时，但当前组合没有挂载')
    }
    const title = truncateText(input.title.trim(), 120)
    const prompt = input.prompt.trim()
    if (title === '') throw new TaskError('invalid', '任务需要一个标题')
    if (prompt === '') throw new TaskError('invalid', '任务需要一个具体的执行说明')
    if (prompt.length > 20_000) throw new TaskError('invalid', '任务说明过长，请压缩到 20000 字符以内')
    const now = this.now()
    const id = newId('task')
    const childId = `quno-task-${id.slice('task_'.length)}`
    const task = this.deps.store.insertTask({
      id,
      qunoId: this.deps.qunoId,
      childSessionId: childId,
      parentSessionId: input.parent.session.id,
      jobId: null,
      title,
      prompt,
      status: 'running',
      now,
    })
    const childPrompt = buildChildPrompt(prompt)
    let activation: ActivationFace
    try {
      activation = await this.deps.subagents.startActivation({
        provider: 'spawn',
        label: title,
        childId,
        request: {
          prompt: [{ type: 'text', text: childPrompt }],
          cwd: input.cwd ?? this.deps.defaultCwd,
          agentPreset: TASK_PRESET,
          maxDepth: 1,
          parent: input.parent,
        },
        signal: this.lifecycle.signal,
        delivery: 'caller',
      })
    } catch (error) {
      const message = (error as Error).message
      this.deps.store.updateTask(task.id, {
        status: 'failed',
        error: { code: 'start-failed', message },
        now: this.now(),
      })
      this.deps.onChange?.()
      throw new TaskError('start-failed', `子任务启动失败：${message}`)
    }
    this.active.set(task.id, activation)
    const updated = this.deps.store.updateTask(task.id, {
      childSessionId: activation.childId,
      now: this.now(),
    })

    const settle = (): Promise<TaskJobOutcome> => this.settle(task.id, activation)
    if (this.deps.jobs !== undefined) {
      const jobId = this.deps.jobs.start({
        kind: 'quno-task',
        label: `Quno 委派任务：${title}`,
        owner: input.parent.session.id,
        outputLimitBytes: 4096,
        run: () => ({
          cancel: (reason?: string) => {
            void activation.dispose().catch(() => {})
            void reason
          },
          done: settle(),
        }),
      })
      this.deps.store.updateTask(task.id, { jobId: String(jobId), now: this.now() })
    } else {
      void settle()
    }
    this.deps.onChange?.()
    return this.deps.store.getTask(updated.id)
  }

  private async settle(taskId: string, activation: ActivationFace): Promise<TaskJobOutcome> {
    try {
      const result = await activation.result
      const text = outputText(result.output)
      if (result.stopReason === 'completed') {
        const artifacts = extractArtifacts(text)
        const body = stripArtifactBlock(text)
        this.complete(taskId, body, artifacts)
        return { status: 'completed', result: truncateText(body, 2000) }
      }
      if (result.stopReason === 'aborted' || result.stopReason === 'refusal') {
        this.interrupt(taskId, result.diagnostic ?? `任务被中止（${result.stopReason}）`)
        return { status: 'killed', detail: result.stopReason }
      }
      this.fail(taskId, `子任务未正常结束（${result.stopReason}）${result.diagnostic === undefined ? '' : `：${result.diagnostic}`}`)
      return { status: 'failed', detail: result.stopReason }
    } catch (error) {
      this.fail(taskId, `子任务执行异常：${(error as Error).message}`)
      return { status: 'failed', detail: (error as Error).message }
    } finally {
      this.active.delete(taskId)
      this.deps.onChange?.()
    }
  }

  private complete(taskId: string, text: string, artifacts: readonly TaskArtifact[]): void {
    const now = this.now()
    const digest = sha256(text)
    this.deps.store.updateTask(taskId, {
      status: 'done',
      result: text,
      resultDigest: digest,
      artifacts,
      error: null,
      now,
    })
    this.enqueueResult(taskId, text)
  }

  private interrupt(taskId: string, reason: string): void {
    this.deps.store.updateTask(taskId, {
      status: 'interrupted',
      result: null,
      error: { code: 'interrupted', message: reason },
      now: this.now(),
    })
  }

  private fail(taskId: string, message: string): void {
    this.deps.store.updateTask(taskId, {
      status: 'failed',
      error: { code: 'task-failed', message },
      now: this.now(),
    })
  }

  private enqueueResult(taskId: string, text: string): void {
    const task = this.deps.store.getTask(taskId)
    const payload: NoticePayload = {
      title: task.title,
      body: text,
      summary: truncateText(`任务完成：${task.title}`, 110),
      why: '委派子任务完成',
      taskId: task.id,
    }
    const notice = this.deps.store.enqueueNotice({
      qunoId: this.deps.qunoId,
      topicKey: `task:${task.id}`,
      materialRevision: 1,
      reminderStage: 0,
      kind: 'task',
      payload,
      eligibleAt: this.now(),
      expiresAt: null,
      now: this.now(),
    })
    if (notice !== null) this.deps.onNotice?.()
  }

  /**
   * Reconcile tasks left `running` by a previous process. A child whose last
   * turn completed is re-flowed idempotently; anything else becomes
   * `interrupted` for the user to resume or abandon.
   */
  async reconcile(): Promise<{ reflowed: number; interrupted: number; failed: number }> {
    let reflowed = 0
    let interrupted = 0
    let failed = 0
    for (const task of this.deps.store.listTasks(this.deps.qunoId, ['running'], 200)) {
      const summary = await this.childOutcome(task)
      if (summary.kind === 'completed') {
        const artifacts = extractArtifacts(summary.text)
        this.complete(task.id, stripArtifactBlock(summary.text), artifacts)
        reflowed += 1
      } else if (summary.kind === 'missing') {
        this.fail(task.id, '子任务会话已不存在，无法恢复')
        failed += 1
      } else if (summary.kind === 'failed') {
        this.fail(task.id, summary.reason)
        failed += 1
      } else {
        this.interrupt(task.id, '桌面退出时任务尚未完成；可以续跑或放弃')
        interrupted += 1
      }
    }
    if (reflowed + interrupted + failed > 0) this.deps.onChange?.()
    return { reflowed, interrupted, failed }
  }

  private async childOutcome(task: TaskRecord): Promise<
    | { kind: 'completed'; text: string }
    | { kind: 'running' }
    | { kind: 'missing' }
    | { kind: 'failed'; reason: string }
  > {
    if (task.childSessionId === null || this.deps.history === undefined) return { kind: 'running' }
    let events: readonly SessionEventLike[]
    try {
      events = (await this.deps.history.readSession(task.childSessionId)).events
    } catch {
      return { kind: 'missing' }
    }
    const lastTurnEnd = [...events].reverse().find(event => event.type === 'turn/end')
    if (lastTurnEnd === undefined) return { kind: 'running' }
    const reason = readTurnEndReason(lastTurnEnd.data)
    if (reason !== 'completed' && reason !== 'max-tokens') return { kind: 'failed', reason: `子任务以 ${reason} 结束` }
    const text = lastAssistantText(events)
    if (text.trim() === '') return { kind: 'failed', reason: '子任务没有产生最终回复' }
    return { kind: 'completed', text }
  }

  /**
   * Resume one interrupted task by re-prompting the same durable child session.
   * The parent Agent must be the exact live main-conversation agent.
   */
  async resume(taskId: string, parent: Agent): Promise<TaskRecord> {
    const task = this.deps.store.getTask(taskId)
    if (task.status !== 'interrupted' && task.status !== 'failed') {
      throw new TaskError('invalid-state', '只有中断或失败的任务可以续跑')
    }
    if (task.childSessionId === null) throw new TaskError('invalid-state', '任务没有可续跑的子会话')
    if (this.deps.subagents === undefined) throw new TaskError('unavailable', 'subagent 运行时不可用')
    const before = await this.lastSeq(task.childSessionId)
    try {
      await this.deps.subagents.sendMessage(
        parent,
        task.childSessionId,
        [{
          type: 'text',
          text: `请继续完成之前委派给你的任务，不要重复已完成的部分。\n\n原任务：\n${task.prompt}`,
        }],
        { signal: this.lifecycle.signal },
      )
    } catch (error) {
      throw new TaskError('resume-failed', `续跑失败：${(error as Error).message}`)
    }
    this.deps.store.updateTask(task.id, { status: 'running', error: null, now: this.now() })
    this.deps.onChange?.()
    // Settle asynchronously by watching the child log.
    void this.awaitResume(task.id, task.childSessionId, before)
    return this.deps.store.getTask(task.id)
  }

  private async awaitResume(taskId: string, childSessionId: string, beforeSeq: number): Promise<void> {
    const deadline = this.now() + 10 * 60_000
    while (this.now() < deadline && !this.lifecycle.signal.aborted) {
      await new Promise(resolve => setTimeout(resolve, 500))
      if (this.deps.history === undefined) return
      try {
        const events = (await this.deps.history.readSession(childSessionId)).events.filter(event => event.seq > beforeSeq)
        const ended = events.some(event => event.type === 'turn/end')
        if (!ended) continue
        const reason = readTurnEndReason(events.find(event => event.type === 'turn/end')?.data)
        if (reason === 'completed' || reason === 'max-tokens') {
          const text = lastAssistantText(events)
          if (text.trim() !== '') {
            this.complete(taskId, stripArtifactBlock(text), extractArtifacts(text))
            return
          }
        }
        this.fail(taskId, `续跑以 ${reason} 结束`)
        return
      } catch {
        return
      }
    }
  }

  /** Give up on an interrupted task (never deletes its child session). */
  abandon(taskId: string): TaskRecord {
    const task = this.deps.store.getTask(taskId)
    if (task.status === 'done') throw new TaskError('invalid-state', '已完成的任务不能放弃')
    const activation = this.active.get(taskId)
    if (activation !== undefined) void activation.dispose().catch(() => {})
    return this.deps.store.updateTask(taskId, {
      status: 'cancelled',
      error: { code: 'cancelled', message: '用户放弃了任务' },
      now: this.now(),
    })
  }

  private async lastSeq(sessionId: string): Promise<number> {
    if (this.deps.history === undefined) return -1
    try {
      const events = (await this.deps.history.readSession(sessionId)).events
      return events.at(-1)?.seq ?? -1
    } catch {
      return -1
    }
  }
}

/** Prompt wrapper that keeps the read-only boundary and artifact convention explicit. */
export function buildChildPrompt(prompt: string): string {
  return `你是 Quno 委派的只读执行助手。完成下面这件事，不要修改任何文件，不要发送外部消息，不要下单或执行任何有外部副作用的操作。

任务：
${prompt}

要求：
- 只读调研、阅读、整理、汇总；需要写文件时只把内容放在最终回复里。
- 最终回复先给出结论，再给出必要的依据。
- 如果产生了可打开的文件、目录或链接，在回复最后追加一行机器可读清单：
  {"artifacts":[{"kind":"file|directory|url|note","label":"...","uri":"..."}]}
- 没有产物就不要输出这一行。`
}

/** Extract and remove the artifact line from the final output. */
export function extractArtifacts(text: string): TaskArtifact[] {
  const match = /\{"artifacts"\s*:\s*(\[[\s\S]*?\])\}\s*$/m.exec(text.trim())
  if (match?.[1] === undefined) return []
  try {
    const parsed = JSON.parse(match[1]) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((entry) => {
      if (typeof entry !== 'object' || entry === null) return []
      const record = entry as Record<string, unknown>
      const kind = record['kind']
      if (kind !== 'file' && kind !== 'directory' && kind !== 'url' && kind !== 'note') return []
      const label = typeof record['label'] === 'string' ? record['label'] : ''
      const uri = typeof record['uri'] === 'string' ? record['uri'] : ''
      if (label === '' || uri === '') return []
      return [{ kind: kind as TaskArtifact['kind'], label: truncateText(label, 200), uri: truncateText(uri, 2000) }]
    }).slice(0, 20)
  } catch {
    return []
  }
}

/** Remove the artifact convention line from user-visible task text. */
export function stripArtifactBlock(text: string): string {
  return text.replace(/\n?\{"artifacts"\s*:\s*\[[\s\S]*?\]\}\s*$/m, '').trim()
}

function outputText(output: readonly unknown[]): string {
  return output.flatMap((block) => {
    if (typeof block !== 'object' || block === null) return []
    const record = block as Record<string, unknown>
    if (record['type'] === 'text' && typeof record['text'] === 'string') return [record['text']]
    return []
  }).join('\n')
}

function readTurnEndReason(data: unknown): string {
  if (typeof data === 'object' && data !== null) {
    const reason = (data as Record<string, unknown>)['reason']
    if (typeof reason === 'string') return reason
    if (typeof reason === 'object' && reason !== null) {
      const kind = (reason as Record<string, unknown>)['kind']
      if (typeof kind === 'string') return kind
    }
  }
  return 'unknown'
}

function lastAssistantText(events: readonly SessionEventLike[]): string {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event === undefined || event.type !== 'assistant/message') continue
    const data = event.data as { message?: { content?: readonly unknown[] } } | undefined
    const content = data?.message?.content
    if (content === undefined) continue
    const text = outputText(content)
    if (text.trim() !== '') return text
  }
  return ''
}

/** Public helper for the task card: L1 status line. */
export function taskStatusLine(task: TaskRecord): string {
  switch (task.status) {
    case 'running': return '进行中'
    case 'done': return '已完成'
    case 'failed': return '失败'
    case 'cancelled': return '已放弃'
    case 'interrupted': return '已中断，可续跑'
  }
}
