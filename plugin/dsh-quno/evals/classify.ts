/**
 * Live failure classification (design §7.3): separate model decision, tool
 * protocol, grounding, harness, fixture and provider problems so "模型不行"
 * can never be the default answer.
 *
 * The classifier is evidence-driven and heuristic at the boundaries; its
 * verdict plus the evidence pointers are recorded in the report so a human
 * can always re-judge from the bundle.
 *
 * @module dsh-quno/evals/classify
 */

import type { ModelGateway, ModelRequestRecord } from './models/gateway.ts'
import type { CaseChecks } from './case.ts'

/** The failure taxonomy of design §7.3. */
export type FailureClass =
  | 'NONE'
  | 'MODEL_DECISION'
  | 'MODEL_TOOL_USE'
  | 'MODEL_GROUNDING'
  | 'HARNESS'
  | 'FIXTURE'
  | 'PROVIDER'

export interface FailureVerdict {
  readonly cls: FailureClass
  readonly detail: string
}

const PROVIDER_PATTERNS: readonly RegExp[] = [
  /live model request failed/i,
  /fetch (failed|NetworkError)/i,
  /ECONN|ENOTFOUND|ETIMEDOUT|EAI_AGAIN/i,
  /\b429\b|rate.?limit/i,
  /\b5\d\d\b (?:from|server error)/i,
  /toolCallId/i,
]

const HARNESS_PATTERNS: readonly RegExp[] = [
  /store is not open/i,
  /is not mounted/i,
  /quno store/i,
  /session ".*" is (?:not )?stored/i,
  /already exists with different content/i,
  /unreachable variant/i,
  /script exhausted/i,
]

/** Classify one live attempt's outcome from its evidence. */
export function classifyLiveFailure(input: {
  readonly error?: string
  readonly checks?: CaseChecks
  readonly gateway: Pick<ModelGateway, 'record'>
  readonly modelCallsHappened: boolean
  readonly budgetExceeded?: boolean
}): FailureVerdict {
  const { error, checks, gateway } = input
  const failedChain = checks?.chain.filter(entry => !entry.pass) ?? []
  const failedSemantics = checks?.semantics.filter(entry => !entry.pass) ?? []

  // 1. Provider/network faults come first: a broken SSE stream or a 429 must
  //    never be scored as a model decision.
  const providerError = gateway.record().find(record => record.error !== undefined && PROVIDER_PATTERNS.some(pattern => pattern.test(record.error ?? '')))
  if (providerError !== undefined) {
    return { cls: 'PROVIDER', detail: `model request ${providerError.role}#${String(providerError.seq)}: ${providerError.error}` }
  }
  if (error !== undefined && PROVIDER_PATTERNS.some(pattern => pattern.test(error))) {
    return { cls: 'PROVIDER', detail: error.slice(0, 200) }
  }

  // 2. Grounding: the run structurally worked (evidence was read, work was
  //    delegated) but the answer contradicts the fixture facts.
  const groundingMiss = failedSemantics.filter(item => item.kind === 'fact' || item.kind === 'no-claim')
  const decisionHeld = failedChain.every(fail => fail.stage !== 'ticket.mandate')
  if (groundingMiss.length > 0 && decisionHeld) {
    return { cls: 'MODEL_GROUNDING', detail: groundingMiss.map(item => item.description).join('; ').slice(0, 240) }
  }

  // 3. Tool protocol: work happened but through wrong targets/params.
  const toolFail = failedChain.find(fail => fail.stage === 'worker.execution' || fail.stage === 'input.delivery')
  if (toolFail !== undefined) {
    return { cls: 'MODEL_TOOL_USE', detail: `${toolFail.stage}/${toolFail.name}: ${JSON.stringify(toolFail.actual ?? {}).slice(0, 200)}` }
  }

  // 3.5. Worker-report stage failures are DECISIONS the worker made (ask vs
  // annotate vs complete) unless the evidence says otherwise; §7.3 keeps the
  // classifier heuristic with the evidence re-judgeable from the bundle.
  const reportFail = failedChain.find(fail => fail.stage === 'worker.report')
  if (reportFail !== undefined) {
    return { cls: 'MODEL_DECISION', detail: `${reportFail.stage}/${reportFail.name}: ${JSON.stringify(reportFail.actual ?? {}).slice(0, 200)}` }
  }

  // 4. Case-level errors: distinguish fixture mistakes from harness bugs by
  //    whether ANY model call happened (a fixture error usually precedes the
  //    first model call; a harness error usually happens mid-link).
  if (error !== undefined) {
    if (!input.modelCallsHappened || HARNESS_PATTERNS.some(pattern => pattern.test(error)) === false && /waiting for|fixture/i.test(error)) {
      return { cls: 'FIXTURE', detail: error.slice(0, 200) }
    }
    return { cls: 'HARNESS', detail: error.slice(0, 200) }
  }

  // 5. Pure behavior failures with structural evidence.
  const decisionFail = failedChain.find(fail => fail.stage === 'ticket.mandate' || fail.stage === 'eval.decision')
  if (decisionFail !== undefined) {
    return { cls: 'MODEL_DECISION', detail: `${decisionFail.stage}/${decisionFail.name}: ${JSON.stringify(decisionFail.actual ?? {}).slice(0, 200)}` }
  }
  if (input.budgetExceeded === true && failedChain.length === 0 && failedSemantics.length === 0 && error === undefined) {
    return { cls: 'HARNESS', detail: 'case budget exceeded (wall duration / model calls) without a behavioral failure' }
  }
  if (failedChain.length > 0) {
    const fail = failedChain[0]!
    return { cls: 'HARNESS', detail: `${fail.stage}/${fail.name}: ${JSON.stringify(fail.actual ?? {}).slice(0, 200)}` }
  }
  return { cls: 'HARNESS', detail: 'failed without a classified signal' }
}

/** One-line summary of a model request record for classification evidence. */
export function describeRequest(record: ModelRequestRecord): string {
  return `${record.role}#${String(record.seq)} finish=${record.output.finish} tools=${record.output.toolCalls.map(call => call.name).join(',')}`
}
