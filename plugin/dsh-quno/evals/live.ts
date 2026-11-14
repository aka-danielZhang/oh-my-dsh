/**
 * The Live E2E case contract (design §4): goal + hidden facts + authorization
 * boundary + success criteria. NO scripted tool sequences — the model chooses
 * its own path and the oracle judges real behavior against the environment.
 *
 * @module dsh-quno/evals/live
 */

import type { CaseChecks } from './case.ts'
import type { EvalRuntime } from './runtime.ts'
import type { ScenarioDriver } from './driver.ts'
import type { EvalStep } from './driver.ts'
import type { HiddenFacts } from './fixtures/hidden.ts'

/** One Live P0/P1 case. */
export interface LiveEvalCase {
  /** Discriminator: live cases run against a REAL model, never scripted. */
  readonly kind: 'live'
  readonly id: string
  readonly title: string
  readonly priority: 'p0' | 'p1'
  /** 用户目标（进入验收报告，不进入模型提示）。 */
  readonly goal: string
  readonly tags: readonly string[]
  /** Draw hidden facts + write fixture files. Runs once per attempt, before steps. */
  readonly fixtures: (seed: number, rt: EvalRuntime) => HiddenFacts
  /** Config/policy preparation (acceptMode, quiet hours, …). */
  readonly policy?: (rt: EvalRuntime, facts: HiddenFacts) => Promise<void>
  /** Driving timeline: user turns, ingests, faults, waits. */
  readonly steps: readonly EvalStep[]
  /**
   * The oracle: hard invariants (chain) + task-fact items (semantics), judged
   * against the real run and the hidden facts. No tool ordering requirements.
   */
  readonly oracle: (input: {
    readonly rt: EvalRuntime
    readonly driver: ScenarioDriver
    readonly facts: HiddenFacts
  }) => CaseChecks | Promise<CaseChecks>
  readonly budget: {
    readonly maxDurationMs: number
    readonly maxModelCalls: number
  }
}

/** All registered live cases (P0 first batch per design §5). */
export async function allLiveCases(): Promise<readonly LiveEvalCase[]> {
  const { liveConversationCases } = await import('./cases/live/live-basic.ts')
  const { liveEvalCases } = await import('./cases/live/live-eval.ts')
  const { liveRecoveryCases } = await import('./cases/live/live-recovery.ts')
  return [...liveConversationCases, ...liveEvalCases, ...liveRecoveryCases]
}

/** True when the entry is a live case. */
export function isLiveCase(entry: unknown): entry is LiveEvalCase {
  return typeof entry === 'object' && entry !== null && (entry as LiveEvalCase).kind === 'live'
}
