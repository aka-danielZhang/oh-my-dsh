/**
 * Unit tests for the run-local dream tool protocol (stage 1): opaque
 * evidence ids, the stable evidence-window hash, argument validation, the
 * ledger budget/protocol machine, and safe error shapes. Store idempotency
 * lives in store.test.ts; the Manager wiring lives in manager-api.test.ts.
 * @module dsh-ohmymemo/tests/dream-tools
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DREAM_TOOL_PROTOCOL_VERSION,
  DreamToolError,
  DreamToolLedger,
  OpaqueEvidenceMap,
  dreamToolError,
  validateCompleteArgs,
  validateRememberArgs,
  completeInputSchema,
  rememberInputSchema,
  type DreamToolLimits,
  type ResolvedDreamEvidence,
} from '../src/dream-tools.ts'
import { computeEvidenceWindowHash, evidenceHandleLine } from '../src/dream.ts'

const LIMITS: DreamToolLimits = {
  maxMemoriesPerRun: 12,
  maxContentChars: 300,
  maxQuoteChars: 200,
  maxTags: 8,
  maxTranscriptBytes: 96_000,
  maxRepairAttemptsPerItem: 2,
  maxRepairAttemptsPerRun: 4,
}

const EVIDENCE: ResolvedDreamEvidence = {
  sessionId: 'sess-1',
  seq: 7,
  messageId: 'msg-7',
  cwd: '/tmp/ws',
  time: Date.parse('2026-09-09T22:10:00Z'),
  text: '用户偏好使用 pnpm 作为包管理器，并坚持在提交前运行完整测试。',
}

function validArgs(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    slot: 1,
    evidenceId: 'ev_x',
    quote: 'pnpm 作为包管理器',
    content: '用户偏好使用 pnpm 作为包管理器。',
    kind: 'semantic',
    scope: 'user',
    key: 'preference.package-manager',
    importance: 0.6,
    tags: ['package-manager'],
    ...overrides,
  }
}

// ------------------------------------------------------- opaque evidence ----

test('opaque evidence ids: ev_ prefix, high entropy, cross-run isolation', () => {
  const map = new OpaqueEvidenceMap()
  const handle = map.add(EVIDENCE)
  assert.match(handle.evidenceId, /^ev_[A-Za-z0-9_-]{21,}$/)
  assert.equal(map.resolve(handle.evidenceId)?.messageId, 'msg-7')
  // 128-bit entropy: ids never repeat across maps (runs).
  const nextRun = new OpaqueEvidenceMap()
  assert.equal(nextRun.resolve(handle.evidenceId), undefined, 'old-run ids resolve to nothing')
  const seen = new Set<string>()
  for (let index = 0; index < 200; index += 1) {
    const minted = nextRun.add({ ...EVIDENCE, seq: index })
    assert.ok(!seen.has(minted.evidenceId))
    seen.add(minted.evidenceId)
  }
})

test('opaque handles expose only workspaceAvailable/time/text, never the locator', () => {
  const map = new OpaqueEvidenceMap()
  const handle = map.add(EVIDENCE)
  const line = evidenceHandleLine(handle)
  assert.ok(!line.includes('sess-1'))
  assert.ok(!line.includes('msg-7'))
  assert.ok(!line.includes('/tmp/ws'))
  assert.deepEqual(JSON.parse(line), {
    evidenceId: handle.evidenceId,
    workspaceAvailable: true,
    time: '2026-09-09T22:10:00.000Z',
    text: EVIDENCE.text,
  })
})

// --------------------------------------------------- evidence window hash ----

function windowInput(overrides: Record<string, unknown> = {}): Parameters<typeof computeEvidenceWindowHash>[0] {
  return {
    protocolVersion: DREAM_TOOL_PROTOCOL_VERSION,
    limits: {
      maxMemoriesPerRun: 12,
      maxContentChars: 300,
      maxQuoteChars: 200,
      maxTags: 8,
      maxTranscriptBytes: 96_000,
    },
    evidence: [{
      sessionId: 'sess-1',
      seq: 7,
      messageId: 'msg-7',
      time: Date.parse('2026-09-09T22:10:00Z'),
      text: 'stable text',
      workspaceScope: null,
    }],
    watermarks: { 'sess-1': 7 },
    ...overrides,
  }
}

test('window hash is deterministic and independent of opaque ids, runIds, and routes', () => {
  const first = computeEvidenceWindowHash(windowInput())
  const second = computeEvidenceWindowHash(windowInput())
  assert.equal(first, second)
  assert.match(first, /^sha256:[0-9a-f]{64}$/)
})

test('window hash changes when evidence, scope availability, limits, watermarks, or protocol version change', () => {
  const base = computeEvidenceWindowHash(windowInput())
  assert.notEqual(base, computeEvidenceWindowHash(windowInput({
    evidence: [{ sessionId: 'sess-1', seq: 8, messageId: 'msg-8', time: 1, text: 'stable text', workspaceScope: null }],
  })))
  assert.notEqual(base, computeEvidenceWindowHash(windowInput({
    evidence: [{ sessionId: 'sess-1', seq: 7, messageId: 'msg-7', time: 1, text: 'changed text', workspaceScope: null }],
  })))
  assert.notEqual(base, computeEvidenceWindowHash(windowInput({
    evidence: [{ sessionId: 'sess-1', seq: 7, messageId: 'msg-7', time: 1, text: 'stable text', workspaceScope: 'workspace:abc' }],
  })))
  assert.notEqual(base, computeEvidenceWindowHash(windowInput({
    limits: { maxMemoriesPerRun: 11, maxContentChars: 300, maxQuoteChars: 200, maxTags: 8, maxTranscriptBytes: 96_000 },
  })))
  assert.notEqual(base, computeEvidenceWindowHash(windowInput({ watermarks: {} })))
  assert.notEqual(base, computeEvidenceWindowHash({ ...windowInput(), protocolVersion: 'dream-tool/v2' }))
})

// ------------------------------------------------------ argument schemas ----

test('remember input schemas stay inside the registry-supported JSON-Schema subset', () => {
  const SUPPORTED = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'description', 'title', 'default', 'examples'])
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return
    for (const [key, value] of Object.entries(node)) {
      if (key === 'properties' || key === 'items') {
        if (typeof value === 'object' && value !== null && !Array.isArray(value)) for (const child of Object.values(value)) walk(child)
        else if (Array.isArray(value)) for (const child of value) walk(child)
        continue
      }
      assert.ok(SUPPORTED.has(key), `schema keyword "${key}" is outside the registry subset`)
      if (typeof value === 'object' && value !== null) walk(value)
    }
  }
  walk(rememberInputSchema(LIMITS))
  walk({ type: 'object', properties: {}, required: [] })
})

test('validateRememberArgs accepts a legal call and trims the quote', () => {
  const args = validateRememberArgs(validArgs(), LIMITS)
  assert.equal(args.slot, 1)
  assert.equal(args.quote, 'pnpm 作为包管理器')
  assert.deepEqual(args.tags, ['package-manager'])
})

test('validateRememberArgs rejects unknown fields, bad slots, and over-limit values with safe codes', () => {
  assert.throws(() => validateRememberArgs(validArgs({ rogue: 1 }), LIMITS), (error: unknown) => {
    const info = (error as DreamToolError).publicInfo
    return info.code === 'DREAM_INVALID_ARGS' && info.retryable === true && info.action === 'correct'
  })
  assert.throws(() => validateRememberArgs(validArgs({ slot: 13 }), LIMITS), (error: unknown) => {
    return (error as DreamToolError).publicInfo.code === 'DREAM_QUOTA_SLOTS'
  })
  assert.throws(() => validateRememberArgs(validArgs({ slot: 1.5 }), LIMITS), (error: unknown) => {
    return (error as DreamToolError).publicInfo.code === 'DREAM_INVALID_ARGS'
  })
  assert.throws(() => validateRememberArgs(validArgs({ quote: 'ab' }), LIMITS), /DREAM_INVALID_ARGS/)
  assert.throws(() => validateRememberArgs(validArgs({ content: 'x'.repeat(301) }), LIMITS), /DREAM_INVALID_ARGS/)
  assert.throws(() => validateRememberArgs(validArgs({ key: '中文!!' }), LIMITS), /DREAM_KEY_INVALID/)
  assert.throws(() => validateRememberArgs(validArgs({ tags: ['a', 'a'] }), LIMITS), (error: unknown) => {
    const info = (error as DreamToolError).publicInfo
    return info.code === 'DREAM_INVALID_ARGS' && info.field === 'tags'
  })
  assert.throws(() => validateRememberArgs(validArgs({ tags: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'] }), LIMITS), /DREAM_INVALID_ARGS/)
  assert.throws(() => validateRememberArgs(validArgs({ validUntil: 'soon' }), LIMITS), /DREAM_INVALID_ARGS/)
  assert.throws(() => validateRememberArgs(validArgs({ importance: 1.4 }), LIMITS), /DREAM_INVALID_ARGS/)
})

test('validateCompleteArgs accepts only the exact disposition object', () => {
  assert.deepEqual(validateCompleteArgs({ disposition: 'done' }), { disposition: 'done' })
  assert.deepEqual(validateCompleteArgs({ disposition: 'no-eligible-memory' }), { disposition: 'no-eligible-memory' })
  assert.throws(() => validateCompleteArgs({ disposition: 'done', extra: 1 }))
  assert.throws(() => validateCompleteArgs({ disposition: 'whatever' }))
  assert.throws(() => validateCompleteArgs({}))
})

// ----------------------------------------------------------------- ledger ----

test('ledger: slot binds, closes on success, reuse is a protocol violation', () => {
  const ledger = new DreamToolLedger(LIMITS)
  const slot = ledger.openSlot(3)
  ledger.beginSlotAttempt(slot)
  ledger.recordSlotSuccess(3, 'created', 'mem_1')
  assert.throws(() => ledger.openSlot(3), (error: unknown) => {
    const info = (error as DreamToolError).publicInfo
    return info.code === 'DREAM_SLOT_REUSED' && info.retryable === false
  })
  const stats = ledger.completionStats()
  assert.equal(stats.created, 1)
  assert.equal(stats.settlement, 'success')
  assert.ok(ledger.protocolViolationCodes.includes('closed-slot-reuse'))
})

test('ledger: per-item budget is one initial attempt plus two repairs, then abandon closes rejected', () => {
  const ledger = new DreamToolLedger(LIMITS)
  const correctable = (): DreamToolError => new DreamToolError('DREAM_QUOTE_NOT_EXACT', '{}', { code: 'DREAM_QUOTE_NOT_EXACT', retryable: true, action: 'correct', field: 'quote' })
  // Initial attempt fails: both per-item repairs remain.
  const initial = ledger.openSlot(1)
  ledger.beginSlotAttempt(initial)
  assert.throws(() => ledger.recordAttemptFailure({ slot: 1, error: correctable() }), (error: unknown) => {
    const info = (error as DreamToolError).publicInfo
    return info.retryable === true && info.repairRemainingForItem === 2
  })
  // Repair 1 fails: one per-item repair remains.
  const repair1 = ledger.openSlot(1)
  ledger.beginSlotAttempt(repair1)
  assert.throws(() => ledger.recordAttemptFailure({ slot: 1, error: correctable() }), (error: unknown) => {
    const info = (error as DreamToolError).publicInfo
    return info.retryable === true && info.repairRemainingForItem === 1
  })
  // Repair 2 fails: per-item budget exhausted → non-retryable abandon, slot closed.
  const repair2 = ledger.openSlot(1)
  ledger.beginSlotAttempt(repair2)
  assert.throws(() => ledger.recordAttemptFailure({ slot: 1, error: correctable() }), (error: unknown) => {
    const info = (error as DreamToolError).publicInfo
    return info.code === 'DREAM_QUOTE_NOT_EXACT' && info.retryable === false && info.action === 'abandon'
  })
  // A later call on the exhausted slot is a protocol violation.
  assert.throws(() => ledger.openSlot(1), /DREAM_SLOT_REUSED/)
  const stats = ledger.completionStats()
  assert.equal(stats.rejected, 1)
  assert.equal(stats.settlement, 'partial')
})

test('ledger: run-global repair budget (4) forces complete', () => {
  const ledger = new DreamToolLedger(LIMITS)
  const correctable = (): DreamToolError => new DreamToolError('DREAM_EVIDENCE_UNKNOWN', '{}', { code: 'DREAM_EVIDENCE_UNKNOWN', retryable: true, action: 'correct', field: 'evidenceId' })
  // Four repairs across four distinct slots exhaust the run budget (each
  // slot's first failure is its free initial attempt; the second is a repair).
  for (let slot = 1; slot <= 4; slot += 1) {
    const bound = ledger.openSlot(slot)
    ledger.beginSlotAttempt(bound)
    assert.throws(() => ledger.recordAttemptFailure({ slot, error: correctable() }), DreamToolError)
    const repaired = ledger.openSlot(slot)
    ledger.beginSlotAttempt(repaired)
    assert.throws(() => ledger.recordAttemptFailure({ slot, error: correctable() }), DreamToolError)
  }
  // Fifth slot: the FIRST failure after budget exhaustion demands complete.
  const fifth = ledger.openSlot(5)
  ledger.beginSlotAttempt(fifth)
  assert.throws(() => ledger.recordAttemptFailure({ slot: 5, error: correctable() }), (error: unknown) => {
    const info = (error as DreamToolError).publicInfo
    return info.code === 'DREAM_EVIDENCE_UNKNOWN' && info.retryable === false && info.action === 'complete'
  })
})

test('ledger: remember call cap is maxMemoriesPerRun + maxRepairAttemptsPerRun', () => {
  const ledger = new DreamToolLedger(LIMITS)
  const total = LIMITS.maxMemoriesPerRun + LIMITS.maxRepairAttemptsPerRun
  for (let index = 0; index < total; index += 1) ledger.beginRememberCall()
  assert.throws(() => ledger.beginRememberCall(), (error: unknown) => {
    const info = (error as DreamToolError).publicInfo
    return info.code === 'DREAM_CALL_LIMIT' && info.action === 'complete' && info.retryable === false
  })
})

test('ledger: complete disposition rules and one-shot completion', () => {
  const ledger = new DreamToolLedger(LIMITS)
  assert.throws(() => ledger.complete('done'), (error: unknown) => {
    return (error as DreamToolError).publicInfo.code === 'DREAM_COMPLETE_DISPOSITION'
  })
  const stats = ledger.complete('no-eligible-memory')
  assert.equal(stats.settlement, 'success')
  assert.equal(stats.created, 0)
  assert.throws(() => ledger.complete('no-eligible-memory'), (error: unknown) => {
    return (error as DreamToolError).publicInfo.code === 'DREAM_COMPLETE_STATE'
  })
})

test('ledger: done with zero calls is refused; no-eligible with calls is refused', () => {
  const empty = new DreamToolLedger(LIMITS)
  assert.throws(() => empty.complete('done'), /DREAM_COMPLETE_DISPOSITION/)
  const used = new DreamToolLedger(LIMITS)
  used.beginRememberCall()
  assert.throws(() => used.complete('no-eligible-memory'), /DREAM_COMPLETE_DISPOSITION/)
})

test('ledger: late calls after complete are protocol violations and refused before any store access', () => {
  const ledger = new DreamToolLedger(LIMITS)
  ledger.beginRememberCall()
  ledger.complete('done')
  assert.throws(() => ledger.beginRememberCall(), (error: unknown) => {
    return (error as DreamToolError).publicInfo.code === 'DREAM_TOOL_PHASE_CLOSED'
  })
  assert.ok(ledger.protocolViolationCodes.includes('late-call-after-complete'))
})

test('ledger: fatal latch blocks complete and further calls', () => {
  const ledger = new DreamToolLedger(LIMITS)
  ledger.latchFatal('DREAM_INFRASTRUCTURE_FATAL')
  assert.throws(() => ledger.beginRememberCall(), /DREAM_INFRASTRUCTURE_FATAL/)
  assert.throws(() => ledger.complete('no-eligible-memory'), /DREAM_INFRASTRUCTURE_FATAL/)
})

test('ledger: abandoned open slots with failures count as rejected at completion', () => {
  const ledger = new DreamToolLedger(LIMITS)
  ledger.beginRememberCall()
  const bound = ledger.openSlot(2)
  ledger.beginSlotAttempt(bound)
  const correctable = new DreamToolError('DREAM_QUOTE_NOT_EXACT', '{}', { code: 'DREAM_QUOTE_NOT_EXACT', retryable: true, action: 'correct', field: 'quote' })
  assert.throws(() => ledger.recordAttemptFailure({ slot: 2, error: correctable }), DreamToolError)
  // The model gives up (never retries) and completes with done.
  const stats = ledger.complete('done')
  assert.equal(stats.rejected, 1)
  assert.equal(stats.settlement, 'partial')
})

test('ledger: policy rejection closes the slot immediately and counts once', () => {
  const ledger = new DreamToolLedger(LIMITS)
  const bound = ledger.openSlot(1)
  ledger.beginSlotAttempt(bound)
  const policy = new DreamToolError('DREAM_POLICY_REFUSED', '{}', { code: 'DREAM_POLICY_REFUSED', retryable: false, action: 'abandon', field: 'quote' })
  assert.throws(() => ledger.recordAttemptFailure({ slot: 1, error: policy }), /DREAM_POLICY_REFUSED/)
  assert.throws(() => ledger.openSlot(1), /DREAM_SLOT_REUSED/)
  assert.equal(ledger.completionStats().rejected, 1)
  assert.equal(ledger.completionStats().toolErrors, 1)
})

test('ledger: close() makes every later call ABORTED', () => {
  const ledger = new DreamToolLedger(LIMITS)
  ledger.close()
  assert.throws(() => ledger.beginRememberCall(), /DREAM_TOOL_ABORTED/)
  assert.throws(() => ledger.complete('done'), /DREAM_TOOL_ABORTED/)
})

// ------------------------------------------------------------ safe errors ----

test('dreamToolError messages are short JSON bodies with no free-form text', () => {
  const error = dreamToolError({ code: 'DREAM_QUOTE_NOT_EXACT', retryable: true, action: 'correct', field: 'quote', repairRemainingForItem: 1, repairRemainingForRun: 3 })
  const parsed = JSON.parse(error.message) as Record<string, unknown>
  assert.deepEqual(parsed, {
    code: 'DREAM_QUOTE_NOT_EXACT',
    retryable: true,
    action: 'correct',
    field: 'quote',
    repairRemainingForItem: 1,
    repairRemainingForRun: 3,
  })
  assert.equal(error.code, 'DREAM_QUOTE_NOT_EXACT')
  assert.equal(error.publicInfo.action, 'correct')
})
