/**
 * The typed case contract: a case declares its scenario (setup + steps), its
 * per-stage structural checks and its per-item semantic expectations.
 *
 * Cases are TypeScript, not YAML — the harness runs them with tsx and every
 * check produces a structured outcome instead of a score.
 *
 * @module dsh-quno/evals/case
 */

import type { StageName } from './trace.ts'
import type { EvalRuntime } from './runtime.ts'
import type { ScenarioDriver } from './driver.ts'
import type { EvalStep } from './driver.ts'

/** How the model gateway answers for one role. */
export type ModelMode = 'live' | 'replay' | 'scripted'

/** One structural check on one stage. */
export interface ChainCheck {
  readonly stage: StageName
  readonly name: string
  readonly pass: boolean
  readonly expected?: unknown
  readonly actual?: unknown
  readonly evidence?: readonly string[]
}

/** One semantic must-item, judged independently (design §8.2). */
export interface SemanticItem {
  readonly id: string
  /** fact: must appear; no-claim: must not claim; provide: next step/evidence; silent: must stay quiet. */
  readonly kind: 'fact' | 'no-claim' | 'provide' | 'silent'
  readonly description: string
  readonly pass: boolean
  readonly evidence?: string
}

/** Checks a case produces after its steps ran. */
export interface CaseChecks {
  readonly chain: readonly ChainCheck[]
  readonly semantics: readonly SemanticItem[]
}

/** The run mode resolved from CLI + case declaration. */
export interface CaseModelPlan {
  readonly router: ModelMode
  readonly worker: ModelMode
}

/** One evaluation case. */
export interface EvalCase {
  readonly id: string
  readonly title: string
  readonly priority: 'p0' | 'p1'
  readonly requirement: string
  readonly tags: readonly string[]
  /** Model mode per role; `--model` overrides both unless the value is `live-locked`. */
  readonly model: CaseModelPlan
  /** Optional fixture/config preparation before steps run. */
  readonly setup?: (rt: EvalRuntime) => Promise<void>
  /** Scripted model turns per role (consumed in order per role). */
  readonly scripts?: {
    readonly router?: readonly import('@deepseek-ai/dsh-llm').StreamChunk[][]
    readonly worker?: readonly import('@deepseek-ai/dsh-llm').StreamChunk[][]
  }
  /** The driving actions, in order. */
  readonly steps: readonly EvalStep[]
  /** Structural + semantic checks; runs once the steps settled. */
  readonly checks: (rt: EvalRuntime, driver: ScenarioDriver) => Promise<CaseChecks> | CaseChecks
  readonly budget: {
    readonly maxDurationMs: number
    readonly maxModelCalls: number
  }
}

/** A case that is declared but intentionally not runnable on this layer. */
export interface BlockedCase {
  readonly id: string
  readonly title: string
  readonly priority: 'p0' | 'p1'
  readonly reason: string
}

/** Registry: all cases known to the CLI. */
export async function allCases(): Promise<readonly (EvalCase | BlockedCase)[]> {
  // Dynamic imports keep the CLI startup cheap and let a broken case file fail
  // with its own loud error instead of hiding the rest of the registry.
  const { conversationCases } = await import('./cases/conversation.ts')
  const { evalCases } = await import('./cases/eval.ts')
  const { notificationCases } = await import('./cases/notification.ts')
  const { recoveryCases } = await import('./cases/recovery.ts')
  const { exchangeCases } = await import('./cases/exchange.ts')
  const { desktopCases } = await import('./cases/desktop.ts')
  const { thirdPartyCases } = await import('./cases/third-party.ts')
  const { cliCases } = await import('./cases/cli.ts')
  return [
    ...conversationCases,
    ...evalCases,
    ...notificationCases,
    ...recoveryCases,
    ...exchangeCases,
    ...desktopCases,
    ...thirdPartyCases,
    ...cliCases,
  ]
}

/** True when the entry is a runnable case. */
export function isRunnable(entry: EvalCase | BlockedCase): entry is EvalCase {
  return (entry as EvalCase).steps !== undefined
}
