/**
 * The Scenario Driver (design §3): executes a case's steps against the real
 * composition and settles every boundary deterministically.
 *
 * Steps are driving actions, not assertions. Every asynchronous wait has a
 * deadline; the suite never hangs on a missing node.
 *
 * @module dsh-quno/evals/driver
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { EffectKind } from '../src/core/model.ts'
import type { EvalRuntime } from './runtime.ts'
import type { ModelRole } from './models/gateway.ts'
import { evalEnvelope, sleep, type EvalOrgan } from './fixtures/organ.ts'
import type { EventEnvelope } from '../src/types.ts'

/** The driving actions a case may use. */
export type EvalStep =
  | { readonly kind: 'human'; readonly text: string | ((facts: import('./fixtures/hidden.ts').HiddenFacts) => string) }
  | {
    readonly kind: 'ingest'
    readonly envelopes:
      | readonly (Partial<EventEnvelope> & { readonly eventKey: string; readonly type: string })[]
      | ((rt: EvalRuntime, driver: ScenarioDriver) => readonly (Partial<EventEnvelope> & { readonly eventKey: string; readonly type: string })[])
    readonly settle?: boolean
  }
  | { readonly kind: 'advanceMs'; readonly ms: number }
  | { readonly kind: 'settle' }
  /** Push a scripted turn built from the CURRENT state (dynamic ids). */
  | { readonly kind: 'script'; readonly role: ModelRole; readonly build: (rt: EvalRuntime, driver: ScenarioDriver) => import('@deepseek-ai/dsh-llm').StreamChunk[] }
  /** Settle until a predicate holds (mid-flight stopping points for crash steps). */
  | { readonly kind: 'settleUntil'; readonly description: string; readonly until: (rt: EvalRuntime) => boolean; readonly stopWhen?: (rt: EvalRuntime) => boolean; readonly deadlineMs?: number }
  | { readonly kind: 'waitFor'; readonly description: string; readonly until: (rt: EvalRuntime) => boolean; readonly stopWhen?: (rt: EvalRuntime) => boolean; readonly deadlineMs?: number }
  | { readonly kind: 'stopTicket'; readonly ticketIdRef: 'active' }
  | { readonly kind: 'failNextEffect'; readonly effect: EffectKind; readonly error: string }
  | { readonly kind: 'exchangeResponse'; readonly payload: unknown }
  /** Deterministically inject the report a worker would submit AFTER a stop. */
  | { readonly kind: 'lateReport'; readonly state: 'ready' | 'progress'; readonly summary: string }
  | { readonly kind: 'config'; readonly patch: Record<string, unknown> }
  | { readonly kind: 'notify'; readonly input: { readonly title: string; readonly summary: string; readonly body: string; readonly why: string; readonly topicKey?: string } }
  /**
   * One ticket-scoped Exchange through the service face (the quno_exchange
   * tool body): the pairing invariant under test, without the model's
   * endpoint-discovery variance in the way.
   */
  | { readonly kind: 'exchange'; readonly ticketIndex: number; readonly payload: Record<string, unknown> }
  | { readonly kind: 'crash' }
  | { readonly kind: 'restart' }

/** One turn of the settle loop's observed activity. */
interface SettleObservation {
  readonly effectsHandled: number
  readonly dueTimers: number
  readonly mainBusy: boolean
  readonly openWorkerRuns: number
}

const SETTLE_DEADLINE_MS = 600_000

/** Drives steps; owns restart composition. */
export class ScenarioDriver {
  private runtime: EvalRuntime
  private readonly compose: () => Promise<EvalRuntime>
  /** Latest active ticket id (for stopTicket/worker session refs). */
  activeTicketId: string | null = null
  /** The synthetic organ instance id (cases build exchange endpoints from it). */
  readonly organInstanceId: string
  /** Outcome of the last lateReport injection. */
  lastLateReport: { refused: boolean; error: string | null } | null = null
  /** Hidden facts for live cases (text builders read them). */
  facts: import('./fixtures/hidden.ts').HiddenFacts = {
    file: '', owner: '', deadline: '', errorCode: '', briefCode: '',
    distractorOwners: [], distractorDeadlines: [], distractorErrorCodes: [],
  }

  constructor(
    initial: EvalRuntime,
    compose: () => Promise<EvalRuntime>,
    private readonly organ: EvalOrgan,
    organInstanceId: string,
  ) {
    this.runtime = initial
    this.compose = compose
    this.organInstanceId = organInstanceId
  }

  get rt(): EvalRuntime {
    return this.runtime
  }

  /** Run one step, tracing stage transitions where a step IS a stage boundary. */
  async run(step: EvalStep): Promise<void> {
    switch (step.kind) {
      case 'human': {
        const agent = this.runtime.mainAgent
        const text = typeof step.text === 'function' ? step.text(this.facts) : step.text
        agent.followup(createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: 'user' },
        }))
        await this.settle()
        return
      }
      case 'ingest': {
        const raw = typeof step.envelopes === 'function' ? step.envelopes(this.runtime, this) : step.envelopes
        const envelopes = raw.map(entry => evalEnvelope(entry))
        await this.organ.ingest(this.organInstanceId, envelopes)
        if (step.settle !== false) await this.settle()
        return
      }
      case 'advanceMs': {
        this.runtime.options.clock.advance(step.ms)
        await this.settle()
        return
      }
      case 'settle':
        await this.settle()
        return
      case 'script':
        this.runtime.options.gateway.pushScript(step.role, step.build(this.runtime, this))
        return
      case 'settleUntil':
        await this.settleUntil(step.description, step.until, step.deadlineMs ?? 30_000, step.stopWhen)
        return
      case 'waitFor':
        await this.waitFor(step.description, step.until, step.deadlineMs ?? 30_000, step.stopWhen)
        return
      case 'stopTicket': {
        const ticketId = this.activeTicketId
        if (ticketId === null) throw new Error('stopTicket: no active ticket recorded')
        this.runtime.host.stopTicket(ticketId)
        await this.settle()
        return
      }
      case 'failNextEffect':
        this.installFault(step.effect, step.error)
        return
      case 'exchangeResponse':
        this.organ.programResponse(step.payload)
        return
      case 'lateReport': {
        // A worker that finished after the human stopped: the engine must
        // refuse the write. Recorded for checks on the driver.
        const ticket = this.runtime.host.repo.listTickets(this.runtime.host.qunoId, { limit: 5 }).at(-1)
        const assignment = ticket === undefined ? undefined : this.runtime.host.repo.listAssignmentsByTicket(ticket.id).at(-1)
        if (ticket === undefined || assignment === undefined) throw new Error('lateReport: no ticket/assignment')
        try {
          this.runtime.host.engine.report({
            assignmentId: assignment.id,
            report: { state: step.state, summary: step.summary, at: this.runtime.now(), artifacts: [] },
            now: this.runtime.now(),
          })
          this.lastLateReport = { refused: false, error: null }
        } catch (caught) {
          this.lastLateReport = { refused: true, error: (caught as Error).message }
        }
        await this.settle()
        return
      }
      case 'config':
        await this.runtime.host.updateConfig({ patch: step.patch })
        await this.settle()
        return
      case 'exchange': {
        // ticketIndex >= 0: a ticket-scoped exchange (worker-requester shape);
        // -1: a router-scoped exchange via the service face (the quno_exchange
        // tool body — requester = the permanent conversation's router).
        if (step.ticketIndex >= 0) {
          const tickets = this.runtime.host.repo.listTickets(this.runtime.host.qunoId, { limit: 10 })
          const ticket = tickets[step.ticketIndex]
          if (ticket === undefined) throw new Error(`exchange: ticket ${String(step.ticketIndex)} does not exist`)
          this.runtime.host.engine.requestExchange({
            kind: 'request',
            requester: `ticket:${ticket.id}`,
            responder: `organ:${this.organInstanceId}`,
            payload: step.payload,
            deadlineMs: 60_000,
            ticketId: ticket.id,
            now: this.runtime.now(),
          })
        } else {
          await this.runtime.host.requestExchange({
            responder: `organ:${this.organInstanceId}`,
            payload: step.payload,
            timeoutMs: 60_000,
          })
        }
        await this.settle()
        return
      }
      case 'notify':
        this.runtime.host.notify({
          title: step.input.title,
          summary: step.input.summary,
          body: step.input.body,
          why: step.input.why,
          ...(step.input.topicKey === undefined ? {} : { topicKey: step.input.topicKey }),
        })
        await this.settle()
        return
      case 'crash':
        await this.runtime.crash()
        return
      case 'restart':
        await this.restart()
        return
    }
  }

  /** Deterministically drain timers, effects, worker turns and the outbox. */
  async settle(): Promise<void> {
    const startedAt = Date.now()
    let stalled = 0
    for (;;) {
      if (Date.now() - startedAt > SETTLE_DEADLINE_MS) {
        throw new Error(`settle deadline exceeded while waiting for: ${JSON.stringify(this.observe())}`)
      }
      const timersFired = this.runtime.options.clock.fireDue(100)
      await this.runtime.host.effects.kick().catch(() => 0)
      await this.runtime.host.checkNow().catch(() => {})
      await this.drainMainAgent()
      this.trackActiveTicket()
      const observation = this.observe()
      if (timersFired === 0 && observation.effectsHandled === 0 && !observation.mainBusy && observation.openWorkerRuns === 0) {
        // One extra quiet sweep to let outbox presentation evidence land.
        await sleep(20)
        const quiet = this.observe()
        if (quiet.effectsHandled === 0 && !quiet.mainBusy && quiet.openWorkerRuns === 0 && this.runtime.options.clock.fireDue(0) === 0) return
      }
      // Virtual-clock Effect retries (30s+ backoff) only come due when time
      // moves: when a pass makes no progress, advance the virtual clock so the
      // domain's own retry schedule plays out (found by live-direct-read: a
      // failed launch Effect sat at due_at=+30s forever).
      stalled += 1
      if (stalled % 8 === 0) this.runtime.options.clock.advance(2_000)
      await sleep(15)
    }
  }

  /** Wait until the main agent is idle AND its pending input lists are drained. */
  private async drainMainAgent(): Promise<void> {
    const agent = this.runtime.mainAgent
    const deadline = Date.now() + 60_000
    for (;;) {
      await agent.whenIdle().catch(() => {})
      const pending = agent.inbox.nextTurn.length + agent.inbox.nextStep.length
      if (agent.status !== 'running' && pending === 0) return
      if (Date.now() > deadline) return
      await sleep(15)
    }
  }

  /** Settle until a predicate holds — mid-flight stopping points for crash steps. */
  async settleUntil(description: string, until: (rt: EvalRuntime) => boolean, deadlineMs: number, stopWhen?: (rt: EvalRuntime) => boolean): Promise<void> {
    const startedAt = Date.now()
    for (;;) {
      if (until(this.runtime)) {
        this.trackActiveTicket()
        return
      }
      if (stopWhen !== undefined && stopWhen(this.runtime)) {
        // A terminal outcome arrived before the goal: stop honestly and let
        // the oracle judge the real end state.
        this.trackActiveTicket()
        return
      }
      if (Date.now() - startedAt > deadlineMs) {
        throw new Error(`timed out after ${String(deadlineMs)}ms settling until ${description}; last state: ${JSON.stringify(this.observe())}`)
      }
      this.runtime.options.clock.fireDue(50)
      await this.runtime.host.effects.kick().catch(() => 0)
      await this.runtime.host.checkNow().catch(() => {})
      await this.runtime.mainAgent.whenIdle().catch(() => {})
      this.trackActiveTicket()
      await sleep(15)
    }
  }

  /** Track the most recent ticket so `stopTicket`/dynamic scripts can use it. */
  private trackActiveTicket(): void {
    try {
      const tickets = this.runtime.host.repo.listTickets(this.runtime.host.qunoId, { limit: 10 })
      const latest = tickets.at(-1)
      if (latest !== undefined) this.activeTicketId = latest.id
    } catch {
      // A crashed runtime has no tickets to track.
    }
  }

  /** Deadline-bounded predicate wait with a clear failure message. */
  async waitFor(description: string, until: (rt: EvalRuntime) => boolean, deadlineMs: number, stopWhen?: (rt: EvalRuntime) => boolean): Promise<void> {
    const startedAt = Date.now()
    let stalledFor = 0
    for (;;) {
      if (until(this.runtime)) return
      if (stopWhen !== undefined && stopWhen(this.runtime)) return
      if (Date.now() - startedAt > deadlineMs) {
        throw new Error(`timed out after ${String(deadlineMs)}ms waiting for ${description}; last state: ${JSON.stringify(this.observe())}`)
      }
      this.runtime.options.clock.fireDue(50)
      await this.runtime.host.effects.kick().catch(() => 0)
      await this.runtime.mainAgent.whenIdle().catch(() => {})
      // Effect backoffs run on the virtual clock: when nothing else progresses,
      // advance it so retries come due (bounded by the real deadline above).
      stalledFor += 1
      if (stalledFor % 10 === 0) this.runtime.options.clock.advance(1_000)
      await sleep(20)
    }
  }

  /** Hard kill: stop without settle, keep durable state. */
  async crashNow(): Promise<void> {
    await this.runtime.crash()
  }

  /** Rebuild the whole composition over the same durable home + journal. */
  async restart(): Promise<void> {
    // host.start() already runs Executor.reconcile + effects.kick inside the
    // fresh composition, so recovery happens as part of composing.
    const fresh = await this.compose()
    this.runtime = fresh
    ;(fresh.options.restarts as { at: number }[]).push({ at: fresh.now() })
    await this.settle()
  }

  /** Push one scripted turn at runtime (cases that adapt turns mid-scenario). */
  pushScript(role: ModelRole, chunks: readonly import('@deepseek-ai/dsh-llm').StreamChunk[]): void {
    this.runtime.options.gateway.pushScript(role, chunks)
  }

  /** Current activity snapshot (deadline failures name what never settled). */
  private observe(): SettleObservation {
    const rt = this.runtime
    let effectsHandled = 0
    let dueTimers = 0
    let openWorkerRuns = 0
    try {
      dueTimers = rt.options.clock.timer.nextDue() !== null && rt.options.clock.timer.nextDue()! <= rt.now() ? 1 : 0
      const repo = rt.host.repo
      effectsHandled = repo.listDueEffects(rt.now(), 50).length
      openWorkerRuns = repo.listOpenWorkerRuns(50).length
    } catch {
      // A crashed runtime observes as quiescent; restart owns recovery.
    }
    const mainBusy = rt.mainAgent?.status === 'running'
    return { effectsHandled, dueTimers, mainBusy, openWorkerRuns }
  }

  /** Wrap one effect handler so its NEXT execution throws (fault injection). */
  private installFault(kind: EffectKind, message: string): void {
    const runtime = this.runtime.host.effects as unknown as {
      deps: { handlers: Partial<Record<EffectKind, (effect: unknown, signal: AbortSignal) => Promise<void>>> }
    }
    const original = runtime.deps.handlers[kind]
    if (original === undefined) throw new Error(`failNextEffect: no handler registered for ${kind}`)
    runtime.deps.handlers[kind] = async () => {
      runtime.deps.handlers[kind] = original
      throw new Error(message)
    }
  }
}
