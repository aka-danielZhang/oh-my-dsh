/**
 * Quno admission policy: which source events may become authorized work, and
 * how an existing Mandate is revalidated before a stopped Ticket resumes.
 *
 * The policy is a pure snapshot: an Eval carries the version it was admitted
 * under, so changing settings mid-flight can never silently widen the range of
 * work that is already in the air. `off / observe / auto` are a ladder, not
 * three unrelated switches:
 *
 * - `off`     only explicit (addressed human) evidence is admitted; nothing
 *             inferred or rule-based is even offered;
 * - `observe` inferred/rule work is evaluated and recorded as `would_accept`
 *             but never creates an automatic Ticket;
 * - `auto`    rule-matched inferred work is admitted and accepted.
 *
 * A human direct request in the permanent conversation is not source work at
 * all: it goes through `EngineForRouter.directAccept` and always carries an
 * explicit Mandate.
 *
 * @module dsh-quno/core/policy
 */

import type {
  AcceptMode,
  GateResult,
  Mandate,
  PolicySnapshot,
  Strength,
  ThreadRecord,
  TicketRecord,
  TriggerRecord,
} from './model.ts'

/** One deterministic admission rule bound to a source. */
export interface PolicyRule {
  readonly id: string
  /** Restrict to one source id. */
  readonly sourceId?: string
  /** Restrict to one of these event types. */
  readonly eventTypes?: readonly string[]
  /** Restrict to events that addressed Quno (mention/direct). */
  readonly requiresAddressed?: boolean
  /** Restrict to at least this source-suggested priority. */
  readonly minPriority?: 'p0' | 'p1' | 'p2' | 'p3'
  /** Only these accept modes may use the rule (default: observe and auto). */
  readonly modes?: readonly AcceptMode[]
}

/** Everything needed to judge admission, captured once per pass. */
export interface PolicyInput {
  readonly version: string
  readonly paused: boolean
  readonly acceptMode: AcceptMode
  readonly evalTimeoutMs: number
  readonly rules: readonly PolicyRule[]
}

const PRIORITY_RANK = { p0: 0, p1: 1, p2: 2, p3: 3 } as const

/** Build one immutable policy snapshot. */
export function buildPolicy(input: PolicyInput): PolicySnapshot {
  const rules = [...input.rules]
  const admittedRuleIds = new Set(rules.map(rule => rule.id))

  const matchRules = (trigger: TriggerRecord): readonly PolicyRule[] => rules.filter(rule => matchesRule(rule, trigger))

  const admitsInferred = (ruleIds: readonly string[]): boolean => {
    if (input.acceptMode !== 'auto') return false
    return ruleIds.some(id => admittedRuleIds.has(id))
  }

  const gate = (trigger: TriggerRecord, thread: ThreadRecord, tickets: readonly TicketRecord[]): GateResult => {
    if (input.paused) {
      return { admissible: false, strength: trigger.human ? 'explicit' : 'inferred', basis: null, reason: 'policy paused' }
    }
    if (thread.closed !== null) {
      return { admissible: false, strength: trigger.human ? 'explicit' : 'inferred', basis: null, reason: 'thread closed' }
    }
    const matched = matchRules(trigger)
    const matchedRuleIds = matched.map(rule => rule.id)
    const scope = { acceptMode: input.acceptMode, threadId: thread.id, ticketIds: tickets.map(ticket => ticket.id) }

    if (trigger.human && trigger.addressed !== null) {
      return {
        admissible: true,
        strength: 'explicit',
        basis: {
          via: 'addressed',
          sourceId: trigger.sourceId,
          scope,
          matchedRuleIds,
        },
        reason: null,
      }
    }

    if (trigger.human) {
      const basis = {
        via: 'admission' as const,
        sourceId: trigger.sourceId,
        scope,
        matchedRuleIds,
      }
      if (input.acceptMode === 'off') {
        return { admissible: false, strength: 'inferred', basis, reason: 'accept mode is off; only addressed human messages are admitted' }
      }
      return { admissible: true, strength: 'inferred', basis, reason: null }
    }

    // Non-human source traffic (bot, CI, integration) needs an explicit rule:
    // being observed by a Collector is never an authorization.
    if (matched.length === 0) {
      return {
        admissible: false,
        strength: 'inferred',
        basis: null,
        reason: 'no policy rule authorizes automatic bot/CI work for this source',
      }
    }
    const basis = {
      via: 'bot' as const,
      sourceId: trigger.sourceId,
      scope,
      matchedRuleIds,
    }
    if (input.acceptMode === 'off') {
      return { admissible: false, strength: 'inferred', basis, reason: 'accept mode is off' }
    }
    if (input.acceptMode === 'observe') {
      return { admissible: true, strength: 'inferred', basis, reason: null }
    }
    // auto: the rule itself is the authorization strength; a rule-matched bot
    // event is admitted as inferred work with an auditable rule citation.
    return { admissible: true, strength: 'inferred', basis, reason: null }
  }

  const revalidate = (mandate: Mandate): { readonly valid: boolean; readonly reason: string | null } => {
    if (input.paused) return { valid: false, reason: 'policy paused' }
    if (mandate.permissionPreset !== 'quno-task') {
      return { valid: false, reason: `unknown permission preset ${String(mandate.permissionPreset)}` }
    }
    if (mandate.strength === 'explicit') {
      // Explicit evidence does not expire just because settings changed, but
      // the task permission surface must still be the shipped read-only one.
      return { valid: true, reason: null }
    }
    if (input.acceptMode === 'off') {
      return { valid: false, reason: 'accept mode is off; inferred mandates cannot resume automatically' }
    }
    if (mandate.policyVersion !== input.version) {
      return { valid: false, reason: `policy version changed (${mandate.policyVersion} → ${input.version})` }
    }
    if (!mandate.basis.matchedRuleIds.some(id => admittedRuleIds.has(id))) {
      return { valid: false, reason: 'the authorizing rule no longer exists' }
    }
    return { valid: true, reason: null }
  }

  return {
    version: input.version,
    paused: input.paused,
    acceptMode: input.acceptMode,
    evalTimeoutMs: input.evalTimeoutMs,
    gate,
    revalidate,
    admitsInferred,
  }
}

/** Deterministic rule matching (no model, no clock). */
export function matchesRule(rule: PolicyRule, trigger: TriggerRecord): boolean {
  if (rule.sourceId !== undefined && rule.sourceId !== trigger.sourceId) return false
  if (rule.eventTypes !== undefined && rule.eventTypes.length > 0 && !rule.eventTypes.includes(trigger.type)) return false
  if (rule.requiresAddressed === true && !(trigger.human && trigger.addressed !== null)) return false
  if (rule.minPriority !== undefined && PRIORITY_RANK[trigger.priority] > PRIORITY_RANK[rule.minPriority]) return false
  return true
}

/** The strongest evidence among a batch (explicit wins, then inferred). */
export function strongestStrength(strengths: readonly Strength[]): Strength {
  return strengths.includes('explicit') ? 'explicit' : 'inferred'
}
