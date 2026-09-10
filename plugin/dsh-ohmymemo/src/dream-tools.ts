/**
 * Run-local dream-memory tool protocol: the `dream_memory_remember` and
 * `dream_memory_complete` tool schemas, the run ledger (phase FSM, slot and
 * repair budgets, protocol latches), the opaque run-local evidence map, and
 * the safe (model-facing) error taxonomy.
 *
 * Security posture: everything in this module is owned by ONE maintenance
 * run. Opaque evidence ids live in a closure Map and never persist; the
 * ledger never outlives the Agent fiber; the durable idempotency identity is
 * the Store's dream write key (see store.createDreamMemory), never the
 * run-local handle.
 * @module dsh-ohmymemo/dream-tools
 */

import { randomBytes } from 'node:crypto'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import z from 'zod'
import type { OhMyMemoService } from './service.ts'
import { detectSecretLike, normalizeKey } from './schema.ts'

/** Wire names of the two run-local dream tools. */
export const DREAM_REMEMBER_TOOL = 'dream_memory_remember'
export const DREAM_COMPLETE_TOOL = 'dream_memory_complete'

/** Tool-only extraction protocol identity (dead-letter + window hash domain). */
export const DREAM_TOOL_PROTOCOL_VERSION = 'dream-tool/v1'

/** Legacy strict-JSON extraction protocol identity. */
export const DREAM_LEGACY_PROTOCOL_VERSION = 'legacy-json/v1'

/** Stable code prefix shared by every dream tool error. */
export type DreamToolErrorCode =
  | 'DREAM_INVALID_ARGS'
  | 'DREAM_EVIDENCE_UNKNOWN'
  | 'DREAM_QUOTE_NOT_EXACT'
  | 'DREAM_WORKSPACE_UNAVAILABLE'
  | 'DREAM_QUOTA_SLOTS'
  | 'DREAM_SLOT_REUSED'
  | 'DREAM_ITEM_REPAIR_EXHAUSTED'
  | 'DREAM_REPAIR_BUDGET_EXHAUSTED'
  | 'DREAM_CALL_LIMIT'
  | 'DREAM_KEY_INVALID'
  | 'DREAM_POLICY_REFUSED'
  | 'DREAM_IDEMPOTENCY_CONFLICT'
  | 'DREAM_REPLAY_RETIRED'
  | 'DREAM_INFRASTRUCTURE_FATAL'
  | 'DREAM_COMPLETE_DISPOSITION'
  | 'DREAM_COMPLETE_STATE'
  | 'DREAM_TOOL_AUTH_DENIED'
  | 'DREAM_TOOL_PHASE_CLOSED'
  | 'DREAM_TOOL_ABORTED'
  | 'DREAM_MODEL_TOOL_UNSUPPORTED'

/** Next action the model should take (plain, machine-routable, body-free). */
export type DreamToolAction = 'correct' | 'abandon' | 'complete' | 'stop'

/** Model-facing structured error: short, safe, and directly actionable. */
export interface DreamToolPublicError {
  code: DreamToolErrorCode
  retryable: boolean
  action: DreamToolAction
  /** Offending argument name when the failure is argument-shaped. */
  field?: string
  /** Remaining per-item repairs (present on item-scoped failures). */
  repairRemainingForItem?: number
  /** Remaining run-global repairs (present on budget-scoped failures). */
  repairRemainingForRun?: number
}

/**
 * A dream tool failure that DSH materializes as an `isError` tool result.
 * The public message is a short JSON body (no cwd, paths, lock holders,
 * evidence text, quotes, or stacks); the machine route lives on
 * `error.info.code`.
 */
export class DreamToolError extends HarnessError {
  /** Safe structured payload mirrored on the error for Host-side routing. */
  readonly publicInfo: DreamToolPublicError

  constructor(code: DreamToolErrorCode, message: string, info: DreamToolPublicError) {
    super(message, code)
    this.name = 'DreamToolError'
    this.publicInfo = info
  }
}

/** Build a safe DreamToolError; the message is the JSON-encoded public info. */
export function dreamToolError(info: DreamToolPublicError): DreamToolError {
  const body: Record<string, unknown> = {
    code: info.code,
    retryable: info.retryable,
    action: info.action,
    ...(info.field !== undefined ? { field: info.field } : {}),
    ...(info.repairRemainingForItem !== undefined ? { repairRemainingForItem: info.repairRemainingForItem } : {}),
    ...(info.repairRemainingForRun !== undefined ? { repairRemainingForRun: info.repairRemainingForRun } : {}),
  }
  return new DreamToolError(info.code, JSON.stringify(body), info)
}

/** Per-run frozen limits shared by the prompt, the schemas, and the ledger. */
export interface DreamToolLimits {
  maxMemoriesPerRun: number
  maxContentChars: number
  maxQuoteChars: number
  maxTags: number
  maxTranscriptBytes: number
  maxRepairAttemptsPerItem: number
  maxRepairAttemptsPerRun: number
}

// ------------------------------------------------------------- schemas ----
// The registry's supported JSON-Schema subset has no min/max keywords; the
// limits below are declared to the model via descriptions and enforced by the
// tool body before any Store access (design §5.4 implementation note).

/** Raw registry-subset input schema for `dream_memory_remember`. */
export function rememberInputSchema(limits: DreamToolLimits): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      slot: {
        type: 'integer',
        description: `Logical entry slot for this run, 1..${limits.maxMemoriesPerRun}. Use one slot per logical memory; keep the same slot when correcting a failure; never reuse a slot that already succeeded.`,
      },
      evidenceId: {
        type: 'string',
        description: 'Opaque evidence id copied verbatim from one BEGIN UNTRUSTED NDJSON line of this run.',
      },
      quote: {
        type: 'string',
        description: `Exact substring (after trimming, ${4}..${limits.maxQuoteChars} chars) of that evidence line's text.`,
      },
      content: {
        type: 'string',
        description: `One self-contained durable fact in Markdown, at most ${limits.maxContentChars} characters; no context pronouns, no credentials, no one-off task state.`,
      },
      kind: { type: 'string', enum: ['semantic', 'episodic', 'procedural'], description: 'semantic=stable fact/preference; episodic=event summary; procedural=way of working.' },
      scope: { type: 'string', enum: ['user', 'workspace'], description: 'user=cross-project; workspace=only when the evidence line has workspaceAvailable=true and the fact is specific to that workspace.' },
      key: { type: 'string', description: 'Short dotted key hint (lowercase letters, digits, dots, hyphens). The Host derives the final durable key.' },
      importance: { type: 'number', description: 'Recall priority 0..1; routine facts stay at or below 0.5.' },
      tags: { type: 'array', items: { type: 'string' }, description: `Up to ${limits.maxTags} stable retrieval tags; no duplicates.` },
      validUntil: { type: 'string', description: 'ISO date or timestamp; ONLY for inherently time-bound facts (exams, ongoing constraints, seasonal device/role).' },
    },
    required: ['slot', 'evidenceId', 'quote', 'content', 'kind', 'scope', 'key', 'importance', 'tags'],
  }
}

/** Raw registry-subset output schema for `dream_memory_remember`. */
export function rememberOutputSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      slot: { type: 'integer' },
      outcome: { type: 'string', enum: ['created', 'already-present'] },
      memoryId: { type: 'string' },
      key: { type: 'string' },
      scope: { type: 'string' },
      createdRemaining: { type: 'integer' },
      repairRemainingForItem: { type: 'integer' },
      repairRemainingForRun: { type: 'integer' },
    },
    required: ['slot', 'outcome', 'memoryId', 'key', 'scope', 'createdRemaining', 'repairRemainingForItem', 'repairRemainingForRun'],
  }
}

/** Raw registry-subset input schema for `dream_memory_complete`. */
export function completeInputSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      disposition: {
        type: 'string',
        enum: ['done', 'no-eligible-memory'],
        description: 'done=at least one dream_memory_remember attempt was made; no-eligible-memory=nothing in the window qualified (no remember attempts).',
      },
    },
    required: ['disposition'],
  }
}

/** Raw registry-subset output schema for `dream_memory_complete`. */
export function completeOutputSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      settlement: { type: 'string', enum: ['success', 'partial'] },
      created: { type: 'integer' },
      alreadyPresent: { type: 'integer' },
      rejected: { type: 'integer' },
      toolErrors: { type: 'integer' },
      repairAttempts: { type: 'integer' },
    },
    required: ['settlement', 'created', 'alreadyPresent', 'rejected', 'toolErrors', 'repairAttempts'],
  }
}

// ------------------------------------------------- argument validation ----
// zod (the same devDependency manager-contract uses) drives the host-side
// validation: TS 6 dropped never-returning-call narrowing, and the registry's
// JSON-Schema subset has no min/max keywords, so the limits live HERE.

const rememberArgsSchema = z.object({
  slot: z.number().int(),
  evidenceId: z.string().min(1),
  quote: z.string(),
  content: z.string(),
  kind: z.enum(['semantic', 'episodic', 'procedural']),
  scope: z.enum(['user', 'workspace']),
  key: z.string(),
  importance: z.number(),
  tags: z.array(z.string()),
  validUntil: z.string().optional(),
}).strict()

const completeArgsSchema = z.object({
  disposition: z.enum(['done', 'no-eligible-memory']),
}).strict()

const VALID_UNTIL_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?)?$/

/** Host-side validation of one `dream_memory_remember` argument object. */
export function validateRememberArgs(args: unknown, limits: DreamToolLimits): {
  slot: number
  evidenceId: string
  quote: string
  content: string
  kind: 'semantic' | 'episodic' | 'procedural'
  scope: 'user' | 'workspace'
  key: string
  importance: number
  tags: string[]
  validUntil?: string
} {
  const shape = rememberArgsSchema.safeParse(args)
  if (!shape.success) {
    const issue = shape.error.issues[0]
    throw dreamToolError({
      code: 'DREAM_INVALID_ARGS',
      retryable: true,
      action: 'correct',
      ...(issue?.path.length ? { field: String(issue.path[0]) } : {}),
    })
  }
  const value = shape.data
  if (value.slot < 1 || value.slot > limits.maxMemoriesPerRun) {
    throw dreamToolError({ code: 'DREAM_QUOTA_SLOTS', retryable: true, action: 'correct', field: 'slot' })
  }
  const quote = value.quote.trim()
  if (quote.length < 4 || quote.length > limits.maxQuoteChars) {
    throw dreamToolError({ code: 'DREAM_INVALID_ARGS', retryable: true, action: 'correct', field: 'quote' })
  }
  if (value.content.trim().length === 0 || value.content.length > limits.maxContentChars) {
    throw dreamToolError({ code: 'DREAM_INVALID_ARGS', retryable: true, action: 'correct', field: 'content' })
  }
  if (normalizeKey(value.key) === undefined) {
    throw dreamToolError({ code: 'DREAM_KEY_INVALID', retryable: true, action: 'correct', field: 'key' })
  }
  if (value.importance < 0 || value.importance > 1 || !Number.isFinite(value.importance)) {
    throw dreamToolError({ code: 'DREAM_INVALID_ARGS', retryable: true, action: 'correct', field: 'importance' })
  }
  if (value.tags.length > limits.maxTags) {
    throw dreamToolError({ code: 'DREAM_INVALID_ARGS', retryable: true, action: 'correct', field: 'tags' })
  }
  const tags = [...new Set(value.tags.map((tag) => tag.trim()).filter((tag) => tag.length > 0))]
  if (tags.length !== value.tags.length) {
    throw dreamToolError({ code: 'DREAM_INVALID_ARGS', retryable: true, action: 'correct', field: 'tags' })
  }
  if (value.validUntil !== undefined && !VALID_UNTIL_RE.test(value.validUntil)) {
    throw dreamToolError({ code: 'DREAM_INVALID_ARGS', retryable: true, action: 'correct', field: 'validUntil' })
  }
  return {
    slot: value.slot,
    evidenceId: value.evidenceId,
    quote,
    content: value.content,
    kind: value.kind,
    scope: value.scope,
    key: value.key,
    importance: value.importance,
    tags,
    ...(value.validUntil !== undefined ? { validUntil: value.validUntil } : {}),
  }
}

/** Host-side validation of one `dream_memory_complete` argument object. */
export function validateCompleteArgs(args: unknown): { disposition: 'done' | 'no-eligible-memory' } {
  const shape = completeArgsSchema.safeParse(args)
  if (!shape.success) {
    throw dreamToolError({ code: 'DREAM_INVALID_ARGS', retryable: true, action: 'correct', field: 'disposition' })
  }
  return { disposition: shape.data.disposition }
}

// ------------------------------------------------- opaque evidence map ----

/** Model-visible envelope for one fitted evidence line. */
export interface DreamEvidenceHandle {
  evidenceId: string
  workspaceAvailable: boolean
  time: string
  text: string
}

/** Host-only resolved evidence: the full locator behind one opaque id. */
export interface ResolvedDreamEvidence {
  sessionId: string
  seq: number
  messageId: string
  cwd?: string
  time: number
  text: string
}

const EVIDENCE_ID_RANDOM_BYTES = 16

/**
 * CSPRNG-backed run-local evidence handles. Ids are `ev_<base64url>` with at
 * least 128 bits of entropy, collision-checked, never derived from the
 * locator, and never persisted; the Map dies with the run.
 */
export class OpaqueEvidenceMap {
  private readonly byId = new Map<string, ResolvedDreamEvidence>()
  private readonly byLocator = new Map<string, DreamEvidenceHandle>()

  /** Mint a handle for one fitted evidence entry. */
  add(evidence: ResolvedDreamEvidence): DreamEvidenceHandle {
    let evidenceId = ''
    do {
      evidenceId = `ev_${randomBytes(EVIDENCE_ID_RANDOM_BYTES).toString('base64url')}`
    } while (this.byId.has(evidenceId))
    this.byId.set(evidenceId, evidence)
    const handle: DreamEvidenceHandle = {
      evidenceId,
      workspaceAvailable: evidence.cwd !== undefined,
      time: new Date(evidence.time).toISOString(),
      text: evidence.text,
    }
    this.byLocator.set(`${evidence.sessionId}:${evidence.seq}`, handle)
    return handle
  }

  /** Exact-string lookup; ids from other runs resolve to undefined. */
  resolve(evidenceId: string): ResolvedDreamEvidence | undefined {
    return this.byId.get(evidenceId)
  }

  /** Handles in insertion (fitted) order — the prompt data section. */
  handles(): DreamEvidenceHandle[] {
    return [...this.byLocator.values()]
  }

  get size(): number {
    return this.byId.size
  }
}

// ----------------------------------------------------------- the ledger ----

/** One slot's lifecycle inside the run. */
interface SlotState {
  attempts: number
  failures: number
  state: 'open' | 'succeeded' | 'rejected'
}

/** Host-side completion statistics produced by the ledger (body-free). */
export interface DreamCompletionStats {
  settlement: 'success' | 'partial'
  created: number
  alreadyPresent: number
  rejected: number
  toolErrors: number
  repairAttempts: number
}

export type DreamLedgerPhase = 'extracting' | 'completed' | 'closed'

/**
 * Run-local ledger and budget authority. The Manager consults it after the
 * turn to decide cursor-commit eligibility; `INVALID` latches (fatal
 * infrastructure, protocol violations) are monotonic.
 */
export class DreamToolLedger {
  phase: DreamLedgerPhase = 'extracting'
  readonly createdIds: string[] = []
  readonly alreadyPresentIds: string[] = []
  rejectedCount = 0
  toolErrors = 0
  repairAttempts = 0
  readonly protocolViolationCodes: string[] = []
  fatalCode: DreamToolErrorCode | null = null
  explicitlyCompleted = false
  completionDisposition: 'done' | 'no-eligible-memory' | null = null
  private readonly slots = new Map<number, SlotState>()
  private rememberCalls = 0
  private runRepairsUsed = 0
  private readonly maxSlots: number
  private readonly maxRepairsPerItem: number
  private readonly maxRepairsPerRun: number

  constructor(limits: DreamToolLimits) {
    this.maxSlots = limits.maxMemoriesPerRun
    this.maxRepairsPerItem = limits.maxRepairAttemptsPerItem
    this.maxRepairsPerRun = limits.maxRepairAttemptsPerRun
  }

  private repairRemainingForRun(): number {
    return Math.max(0, this.maxRepairsPerRun - this.runRepairsUsed)
  }

  private repairRemainingForItem(slot: SlotState | undefined): number {
    if (slot === undefined || slot.attempts === 0) return this.maxRepairsPerItem
    // The FIRST failure of a slot is the initial attempt's failure; only the
    // failures after it consume this item's repair budget.
    const consumedRepairs = Math.max(0, slot.failures - 1)
    return Math.max(0, this.maxRepairsPerItem - consumedRepairs)
  }

  /** Call budget gate: every body entry counts, valid or not. */
  beginRememberCall(): void {
    if (this.phase !== 'extracting') {
      if (this.phase === 'closed') throw dreamToolError({ code: 'DREAM_TOOL_ABORTED', retryable: false, action: 'stop' })
      this.recordProtocolViolation('late-call-after-complete')
      throw dreamToolError({ code: 'DREAM_TOOL_PHASE_CLOSED', retryable: false, action: 'stop' })
    }
    if (this.fatalCode !== null) {
      throw dreamToolError({ code: 'DREAM_INFRASTRUCTURE_FATAL', retryable: false, action: 'stop' })
    }
    this.rememberCalls += 1
    if (this.rememberCalls > this.maxSlots + this.maxRepairsPerRun) {
      throw dreamToolError({ code: 'DREAM_CALL_LIMIT', retryable: false, action: 'complete' })
    }
  }

  /**
   * Validate the slot: binding on first legal use; closed-slot reuse is a
   * protocol violation; exhausted per-item repairs throw the abandon error
   * (the caller routes it through recordAttemptFailure, which closes the
   * slot as rejected exactly once).
   */
  openSlot(slot: number): SlotState {
    const existing = this.slots.get(slot)
    if (existing !== undefined) {
      if (existing.state !== 'open') {
        this.recordProtocolViolation('closed-slot-reuse')
        throw dreamToolError({ code: 'DREAM_SLOT_REUSED', retryable: false, action: 'abandon', field: 'slot' })
      }
      if (this.repairRemainingForItem(existing) === 0) {
        throw dreamToolError({ code: 'DREAM_ITEM_REPAIR_EXHAUSTED', retryable: false, action: 'abandon', field: 'slot', repairRemainingForRun: this.repairRemainingForRun() })
      }
      return existing
    }
    const fresh: SlotState = { attempts: 0, failures: 0, state: 'open' }
    this.slots.set(slot, fresh)
    return fresh
  }

  /** Record that one slot attempt started (before Store access). */
  beginSlotAttempt(slot: SlotState): void {
    if (slot.attempts > 0) this.repairAttempts += 1
    slot.attempts += 1
  }

  /**
   * Account one failed attempt and produce the safe error to feed back.
   * Slotless failures (invalid args) consume the run-global budget only.
   *
   * - Correctable failures stay retryable while per-item/run budgets last;
   *   per-item exhaustion closes the slot as rejected (abandon); run-budget
   *   exhaustion demands `complete` (the slot is settled at completion time).
   * - Policy rejections (secret/tombstone/conflict/retired) close the slot as
   *   rejected immediately.
   * - Fatal failures latch the run; the slot stays open (the run is over).
   */
  recordAttemptFailure(options: { slot: number | undefined; error: DreamToolError }): never {
    this.toolErrors += 1
    const slotState = options.slot !== undefined ? this.slots.get(options.slot) : undefined
    if (slotState !== undefined) slotState.failures += 1
    // Repairs are failures beyond a slot's initial attempt; slotless failures
    // always consume the run-global repair budget.
    const consumesRunRepair = slotState === undefined || slotState.attempts > 1
    if (consumesRunRepair) this.runRepairsUsed += 1
    const itemRemaining = slotState !== undefined ? this.repairRemainingForItem(slotState) : this.maxRepairsPerItem
    const runRemaining = this.repairRemainingForRun()
    const previous = options.error.publicInfo

    if (previous.code === 'DREAM_INFRASTRUCTURE_FATAL') {
      this.latchFatal('DREAM_INFRASTRUCTURE_FATAL')
      throw dreamToolError({ ...previous, repairRemainingForItem: itemRemaining, repairRemainingForRun: runRemaining })
    }
    if (!previous.retryable && previous.action === 'abandon') {
      // Policy rejection: this item is finally given up.
      if (options.slot !== undefined) this.recordSlotRejected(options.slot)
      throw dreamToolError({ ...previous, repairRemainingForItem: 0, repairRemainingForRun: runRemaining })
    }
    if (previous.retryable) {
      if (slotState !== undefined && itemRemaining === 0) {
        if (options.slot !== undefined) this.recordSlotRejected(options.slot)
        throw dreamToolError({ ...previous, retryable: false, action: 'abandon', repairRemainingForItem: 0, repairRemainingForRun: runRemaining })
      }
      if (runRemaining === 0) {
        throw dreamToolError({ ...previous, retryable: false, action: 'complete', repairRemainingForItem: itemRemaining, repairRemainingForRun: 0 })
      }
      throw dreamToolError({ ...previous, repairRemainingForItem: itemRemaining, repairRemainingForRun: runRemaining })
    }
    // Any other non-retryable classification (quota/phase/auth) rethrows.
    throw dreamToolError({ ...previous, repairRemainingForItem: itemRemaining, repairRemainingForRun: runRemaining })
  }

  /** Record a successful write (created or exact replay). Closes the slot. */
  recordSlotSuccess(slot: number, outcome: 'created' | 'already-present', memoryId: string): void {
    const state = this.slots.get(slot)
    if (state === undefined) throw new Error(`dream ledger: success for unbound slot ${slot}`)
    state.state = outcome === 'created' ? 'succeeded' : 'succeeded'
    if (outcome === 'created') this.createdIds.push(memoryId)
    else this.alreadyPresentIds.push(memoryId)
  }

  /** Close a slot as a policy rejection (secret/tombstone/conflict/abandon). */
  recordSlotRejected(slot: number): void {
    const state = this.slots.get(slot)
    if (state !== undefined && state.state === 'open') {
      state.state = 'rejected'
      this.rejectedCount += 1
    }
  }

  private closeSlot(slot: number, state: 'succeeded' | 'rejected'): void {
    const existing = this.slots.get(slot)
    if (existing !== undefined) existing.state = state
  }

  /** Whether one slot is closed for good (succeeded or rejected). */
  isSlotClosed(slot: number): boolean {
    const state = this.slots.get(slot)
    return state !== undefined && state.state !== 'open'
  }

  /** Latch an infrastructure failure; complete is refused afterwards. */
  latchFatal(code: DreamToolErrorCode): void {
    if (this.fatalCode === null) this.fatalCode = code
  }

  /** Record a deterministic protocol violation (monotonic latch). */
  recordProtocolViolation(code: string): void {
    if (this.protocolViolationCodes.length < 32 && !this.protocolViolationCodes.includes(code)) {
      this.protocolViolationCodes.push(code)
    }
  }

  /** Any remember attempt happened? Drives complete-disposition legality. */
  hasRememberCalls(): boolean {
    return this.rememberCalls > 0
  }

  /**
   * Atomically flip the phase to `completed` and produce the completion
   * stats. Throws the safe complete error when the run cannot settle.
   */
  complete(disposition: 'done' | 'no-eligible-memory'): DreamCompletionStats {
    if (this.phase !== 'extracting') {
      if (this.phase === 'closed') throw dreamToolError({ code: 'DREAM_TOOL_ABORTED', retryable: false, action: 'stop' })
      this.recordProtocolViolation('repeated-complete')
      throw dreamToolError({ code: 'DREAM_COMPLETE_STATE', retryable: false, action: 'stop' })
    }
    if (this.fatalCode !== null) {
      throw dreamToolError({ code: 'DREAM_INFRASTRUCTURE_FATAL', retryable: false, action: 'stop' })
    }
    if (disposition === 'no-eligible-memory' && this.rememberCalls > 0) {
      throw dreamToolError({ code: 'DREAM_COMPLETE_DISPOSITION', retryable: true, action: 'correct', field: 'disposition' })
    }
    if (disposition === 'done' && this.rememberCalls === 0) {
      throw dreamToolError({ code: 'DREAM_COMPLETE_DISPOSITION', retryable: true, action: 'correct', field: 'disposition' })
    }
    this.phase = 'completed'
    this.explicitlyCompleted = true
    this.completionDisposition = disposition
    return this.completionStats()
  }

  /** Body-free statistics snapshot for audit/checkpoint. */
  completionStats(): DreamCompletionStats {
    return {
      settlement: this.rejectedTotal() > 0 ? 'partial' : 'success',
      created: this.createdIds.length,
      alreadyPresent: this.alreadyPresentIds.length,
      rejected: this.rejectedTotal(),
      toolErrors: this.toolErrors,
      repairAttempts: this.repairAttempts,
    }
  }

  /**
   * Rejected items: policy rejections plus open slots abandoned with at
   * least one failure (the model gave up without a success).
   */
  rejectedTotal(): number {
    let abandoned = 0
    for (const state of this.slots.values()) {
      if (state.state === 'open' && state.failures > 0) abandoned += 1
    }
    return this.rejectedCount + abandoned
  }

  /** Close on teardown: further tool calls are ABORTED. */
  close(): void {
    this.phase = 'closed'
  }
}

// --------------------------------------------------------- tool wiring ----

/** Closure dependencies the Manager binds per run. */
export interface DreamToolClosure {
  service: OhMyMemoService
  evidence: OpaqueEvidenceMap
  ledger: DreamToolLedger
  limits: DreamToolLimits
  /** Run nonce from the Manager; tools refuse calls from other runs. */
  nonce: string
  /** Atomic marker that the current run is still the owning run. */
  isCurrentRun: () => boolean
  /** Abort signal mirrored from the run. */
  aborted: () => boolean
}

/**
 * Shared guard checks for both tools: caller identity, no nested dispatch,
 * run identity, nonce, phase, and abort. Throws the safe auth errors; never
 * touches the service.
 */
export function assertDreamToolAuthorized(closure: DreamToolClosure, exec: { agent?: unknown; parent?: unknown }, expectedAgent: unknown, toolName: string): void {
  if (closure.aborted()) throw dreamToolError({ code: 'DREAM_TOOL_ABORTED', retryable: false, action: 'stop' })
  if (closure.ledger.phase === 'closed') throw dreamToolError({ code: 'DREAM_TOOL_ABORTED', retryable: false, action: 'stop' })
  if (exec.agent !== expectedAgent || exec.agent === undefined) {
    throw dreamToolError({ code: 'DREAM_TOOL_AUTH_DENIED', retryable: false, action: 'stop' })
  }
  if (exec.parent !== undefined) {
    closure.ledger.recordProtocolViolation('nested-dispatch')
    throw dreamToolError({ code: 'DREAM_TOOL_AUTH_DENIED', retryable: false, action: 'stop' })
  }
  if (!closure.isCurrentRun()) {
    throw dreamToolError({ code: 'DREAM_TOOL_AUTH_DENIED', retryable: false, action: 'stop' })
  }
  if (toolName !== DREAM_REMEMBER_TOOL && toolName !== DREAM_COMPLETE_TOOL) {
    throw dreamToolError({ code: 'DREAM_TOOL_AUTH_DENIED', retryable: false, action: 'stop' })
  }
}

/**
 * Quote grounding + secret screening against the mapped evidence. Throws the
 * safe correctable errors.
 */
export function groundEvidence(closure: DreamToolClosure, evidenceId: string, quote: string): ResolvedDreamEvidence {
  const source = closure.evidence.resolve(evidenceId)
  if (source === undefined) {
    throw dreamToolError({ code: 'DREAM_EVIDENCE_UNKNOWN', retryable: true, action: 'correct', field: 'evidenceId' })
  }
  if (!source.text.includes(quote)) {
    throw dreamToolError({ code: 'DREAM_QUOTE_NOT_EXACT', retryable: true, action: 'correct', field: 'quote' })
  }
  const secret = detectSecretLike(quote) ?? detectSecretLike(source.text)
  if (secret !== undefined) {
    throw dreamToolError({ code: 'DREAM_POLICY_REFUSED', retryable: false, action: 'abandon', field: 'quote' })
  }
  return source
}
