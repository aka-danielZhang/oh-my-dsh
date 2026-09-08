import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SessionLogSnapshot } from '@deepseek-ai/dsh-session-query'
import {
  buildCuratorPrompt,
  buildDreamPrompt,
  cursorWatermarks,
  dueCatchUpBoundary,
  extractDreamSource,
  latestScheduleBoundary,
  nextScheduleBoundary,
  parseCuratorOutput,
  parseDreamOutput,
  parseLocalTime,
  type CuratorCatalogEntry,
  type DreamEvidence,
  type DreamSourceSession,
} from '../src/dream.ts'

function snapshot(): SessionLogSnapshot {
  return {
    session: {
      id: 'session-user',
      createdAt: Date.parse('2026-09-03T00:00:00Z'),
      cwd: '/work/project',
      seedLength: 2,
    },
    events: [
      { seq: 0, time: Date.parse('2026-09-03T00:01:00Z'), type: 'user/message', surfaceOp: 'append', data: { id: 'seed', source: { kind: 'user' }, content: [{ type: 'text', text: 'inherited' }] } },
      { seq: 2, time: Date.parse('2026-09-03T08:00:00Z'), type: 'user/message', surfaceOp: 'append', data: { id: 'm2', source: { kind: 'plugin', plugin: 'test', form: 'notice' }, content: [{ type: 'text', text: 'plugin text' }] } },
      { seq: 3, time: Date.parse('2026-09-03T08:01:00Z'), type: 'user/message', surfaceOp: 'append', data: { id: 'm3', source: { kind: 'user' }, content: [{ type: 'text', text: 'I always use pnpm for JavaScript projects.' }] } },
      { seq: 4, time: Date.parse('2026-09-03T08:02:00Z'), type: 'user/message', surfaceOp: 'append', data: { id: 'm4', source: { kind: 'user' }, content: [{ type: 'text', text: 'Token ghp_abcdefghijklmnopqrstuvwxyz must stay hidden.' }] } },
      { seq: 5, time: Date.parse('2026-09-03T08:03:00Z'), type: 'user/message', surfaceOp: { op: 'replace', start: 3, end: 3 }, data: { id: 'm5', source: { kind: 'user' }, content: [{ type: 'text', text: 'model-only replacement' }] } },
    ],
  } as unknown as SessionLogSnapshot
}

test('local schedule helpers preserve wall-clock time and bound catch-up', () => {
  assert.deepEqual(parseLocalTime('02:15'), { hour: 2, minute: 15 })
  assert.throws(() => parseLocalTime('24:00'))
  const now = new Date(2026, 8, 3, 12, 0, 0)
  const latest = latestScheduleBoundary(now, '02:15')
  const next = nextScheduleBoundary(now, '02:15')
  assert.equal(latest.getHours(), 2)
  assert.equal(latest.getMinutes(), 15)
  assert.equal(latest.getDate(), 3)
  assert.equal(next.getDate(), 4)
  assert.equal(dueCatchUpBoundary(now, '02:15', null, 36 * 3_600_000), latest.getTime())
  assert.equal(dueCatchUpBoundary(now, '02:15', latest.getTime(), 36 * 3_600_000), undefined)
  assert.equal(dueCatchUpBoundary(now, '02:15', null, 60_000), undefined)
})

test('source extraction admits only unseen direct-user text and fails closed on secrets', () => {
  const source = extractDreamSource(snapshot(), undefined, {
    cutoffMs: Date.parse('2026-09-03T00:00:00Z'),
    maxMessages: 10,
    maxMessageChars: 200,
  })
  assert.equal(source.sessionId, 'session-user')
  assert.equal(source.capturedThroughSeq, 5)
  assert.deepEqual(source.messages.map(message => message.seq), [3])
  assert.equal(source.messages[0]?.cwd, '/work/project')
  assert.deepEqual(extractDreamSource(snapshot(), 3, {
    cutoffMs: 0,
    maxMessages: 10,
    maxMessageChars: 200,
  }).messages, [])
})

test('prompt input is byte-bounded and output proposals require exact evidence quotes', () => {
  const source = extractDreamSource(snapshot(), undefined, {
    cutoffMs: 0,
    maxMessages: 10,
    maxMessageChars: 200,
  })
  const prompt = buildDreamPrompt([source], { maxTranscriptBytes: 4096, maxMemories: 4, maxContentChars: 500 })
  assert.equal(prompt.messageCount, 1)
  assert.ok(prompt.prompt.includes('BEGIN UNTRUSTED NDJSON'))
  assert.ok(prompt.prompt.includes('"workspaceAvailable":true'))
  assert.ok(!prompt.prompt.includes('/work/project'))
  const accepted = parseDreamOutput(JSON.stringify({
    memories: [{
      content: 'The user prefers pnpm for JavaScript projects.',
      kind: 'semantic',
      scope: 'workspace',
      key: 'preference.package-manager',
      importance: 0.8,
      tags: ['javascript', 'pnpm'],
      evidence: { sessionId: 'session-user', seq: 3, quote: 'always use pnpm' },
    }],
  }), prompt.evidence, { maxMemories: 4, maxContentChars: 500 })
  assert.equal(accepted.rejected, 0)
  assert.equal(accepted.proposals.length, 1)
  assert.match(accepted.proposals[0]!.key, /^dream\.preference\.package-manager\.[a-f0-9]{12}$/)
  assert.equal(accepted.proposals[0]!.evidence.seq, 3)

  assert.throws(() => parseDreamOutput(JSON.stringify({
    memories: [{
      content: 'The user prefers npm.',
      kind: 'semantic',
      scope: 'user',
      key: 'preference.package-manager',
      importance: 0.8,
      tags: [],
      evidence: { sessionId: 'session-user', seq: 3, quote: 'always use npm' },
    }],
  }), prompt.evidence, { maxMemories: 4, maxContentChars: 500 }), /invalid or over-limit/)
})

test('prompt byte limit emits complete JSON and truncates oversized text without starvation', () => {
  const source = extractDreamSource(snapshot(), undefined, {
    cutoffMs: 0,
    maxMessages: 10,
    maxMessageChars: 200,
  })
  const prompt = buildDreamPrompt([source], { maxTranscriptBytes: 8, maxMemories: 1, maxContentChars: 500 })
  assert.equal(prompt.messageCount, 0)
  assert.equal(prompt.evidence.size, 0)

  const bounded = buildDreamPrompt([source], { maxTranscriptBytes: 150, maxMemories: 1, maxContentChars: 500 })
  assert.equal(bounded.messageCount, 1)
  const line = bounded.prompt.split('BEGIN UNTRUSTED NDJSON\n')[1]?.split('\nEND UNTRUSTED NDJSON')[0]
  assert.ok(line !== undefined)
  const payload = JSON.parse(line) as { text: string }
  assert.ok(payload.text.length > 0)
  assert.ok(payload.text.length < source.messages[0]!.text.length)
  assert.equal(bounded.evidence.get('session-user:3')?.text, payload.text)
  assert.throws(() => parseDreamOutput('not json', new Map(), { maxMemories: 1, maxContentChars: 100 }))
  assert.throws(() => parseDreamOutput('result: {"memories":[]}', new Map(), { maxMemories: 1, maxContentChars: 100 }))
  assert.throws(() => parseDreamOutput('```json\n{"memories":[]}\n```', new Map(), { maxMemories: 1, maxContentChars: 100 }))
})

test('cursor watermarks advance only through the contiguous fitted seq prefix', () => {
  const session = (sessionId: string, seqs: number[], times?: number[]): DreamSourceSession => ({
    sessionId,
    capturedThroughSeq: Math.max(...seqs),
    lastEventAt: times?.at(-1) ?? 0,
    messages: seqs.map((seq, index) => ({
      sessionId,
      seq,
      messageId: `m${seq}`,
      time: times?.[index] ?? index,
      text: `message ${seq} of ${sessionId}`,
    })),
  })
  const evidence = (sessionId: string, seqs: number[]): DreamEvidence[] =>
    seqs.map(seq => ({ sessionId, seq, messageId: `m${seq}`, time: 0, text: 'x' }))

  // Contiguous prefix: every selected message fitted → cursor reaches the max seq.
  const contiguous = cursorWatermarks([session('s1', [3, 7])], evidence('s1', [3, 7]))
  assert.equal(contiguous.get('s1'), 7)

  // Non-monotonic timestamps: only the HIGHER seq fitted (earlier-timestamped
  // lower seq missed the byte budget) → the gap freezes the session cursor.
  const gap = cursorWatermarks([session('s1', [3, 7], [20, 10])], evidence('s1', [7]))
  assert.equal(gap.has('s1'), false, 'a gap must not advance the cursor past unfitted evidence')

  // A later gap keeps the earlier contiguous prefix watermark.
  const prefix = cursorWatermarks([session('s2', [1, 2, 5, 9])], evidence('s2', [1, 2, 5]))
  assert.equal(prefix.get('s2'), 5, 'contiguous prefix still advances')

  // Nothing fitted → no entry.
  assert.equal(cursorWatermarks([session('s3', [4])], []).has('s3'), false)
})

test('truncated output salvages the complete prefix and marks the result', () => {
  const source = extractDreamSource(snapshot(), undefined, {
    cutoffMs: 0,
    maxMessages: 10,
    maxMessageChars: 200,
  })
  const prompt = buildDreamPrompt([source], { maxTranscriptBytes: 4096, maxMemories: 4, maxContentChars: 500 })
  const first = {
    content: 'The user prefers pnpm for JavaScript projects.',
    kind: 'semantic',
    scope: 'workspace',
    key: 'preference.package-manager',
    importance: 0.8,
    tags: ['pnpm'],
    evidence: { sessionId: 'session-user', seq: 3, quote: 'always use pnpm' },
  }
  // Cut mid-way through the second item: only the first survives, the result
  // is marked truncated, and nothing throws.
  const cut = `${JSON.stringify({ memories: [first] }).slice(0, -2)},{"content":"second item that never`
  const salvaged = parseDreamOutput(cut, prompt.evidence, { maxMemories: 4, maxContentChars: 500 })
  assert.equal(salvaged.truncated, true)
  assert.equal(salvaged.rejected, 0)
  assert.equal(salvaged.proposals.length, 1)
  assert.match(salvaged.proposals[0]!.key, /^dream\.preference\.package-manager\./)

  // An ungrounded item among the salvaged ones still fails the batch:
  // truncation excuses missing items, never invalid ones.
  const poisoned = `${JSON.stringify({ memories: [{ ...first, evidence: { sessionId: 'session-user', seq: 3, quote: 'fabricated quote text' } }] }).slice(0, -2)},{"content":"cut`
  assert.throws(() => parseDreamOutput(poisoned, prompt.evidence, { maxMemories: 4, maxContentChars: 500 }), SyntaxError)

  // Cut before any item closes → nothing salvageable → the original error.
  assert.throws(() => parseDreamOutput('{"memories":[{"content":"lorem', prompt.evidence, { maxMemories: 4, maxContentChars: 500 }), SyntaxError)

  // No memories array at all → shape violation, not truncation → rethrow.
  assert.throws(() => parseDreamOutput('{"results":[{"content":"x', prompt.evidence, { maxMemories: 4, maxContentChars: 500 }), SyntaxError)
})

test('over-long evidence quotes are rejected and the prompt states both limits', () => {
  const source = extractDreamSource(snapshot(), undefined, {
    cutoffMs: 0,
    maxMessages: 10,
    maxMessageChars: 200,
  })
  const prompt = buildDreamPrompt([source], { maxTranscriptBytes: 4096, maxMemories: 4, maxContentChars: 300 })
  assert.ok(prompt.prompt.includes('at most 300 characters'))
  assert.ok(prompt.prompt.includes('at most 200 characters'))
  const longQuote = 'always use pnpm'.padEnd(201, 'x')
  assert.throws(() => parseDreamOutput(JSON.stringify({
    memories: [{
      content: 'The user prefers pnpm.',
      kind: 'semantic',
      scope: 'workspace',
      key: 'preference.package-manager',
      importance: 0.8,
      tags: [],
      evidence: { sessionId: 'session-user', seq: 3, quote: longQuote },
    }],
  }), prompt.evidence, { maxMemories: 4, maxContentChars: 300 }), /invalid or over-limit/)
})

test('extraction prompt carries the valid_until guidance and parses it through', () => {
  const source = extractDreamSource(snapshot(), undefined, {
    cutoffMs: 0,
    maxMessages: 10,
    maxMessageChars: 200,
  })
  const prompt = buildDreamPrompt([source], { maxTranscriptBytes: 4096, maxMemories: 4, maxContentChars: 500 })
  assert.ok(prompt.prompt.includes('valid_until (optional ISO 8601 date)'), 'time-bound guidance present')
  assert.ok(prompt.prompt.includes('Do not extract one-off task states'))

  const accepted = parseDreamOutput(JSON.stringify({
    memories: [{
      content: 'The user is preparing for the November architect exam.',
      kind: 'semantic',
      scope: 'user',
      key: 'plan.architect-exam',
      importance: 0.6,
      tags: ['exam'],
      valid_until: '2026-11-30',
      evidence: { sessionId: 'session-user', seq: 3, quote: 'always use pnpm' },
    }],
  }), prompt.evidence, { maxMemories: 4, maxContentChars: 500 })
  assert.equal(accepted.proposals[0]?.validUntil, '2026-11-30')

  // A malformed valid_until fails the strict path (whole batch) — the same
  // discipline as any other ungrounded field.
  assert.throws(() => parseDreamOutput(JSON.stringify({
    memories: [{
      content: 'The user is preparing for an exam.',
      kind: 'semantic',
      scope: 'user',
      key: 'plan.exam',
      importance: 0.6,
      tags: [],
      valid_until: 'next month',
      evidence: { sessionId: 'session-user', seq: 3, quote: 'always use pnpm' },
    }],
  }), prompt.evidence, { maxMemories: 4, maxContentChars: 500 }), /invalid or over-limit/)
})

function curatorCatalog(): CuratorCatalogEntry[] {
  return [
    {
      id: 'mem_01J5G0Z0Z0Z0Z0Z0Z0Z0Z0Z0Z0',
      key: 'preference.package-manager',
      kind: 'semantic',
      importance: 0.8,
      confirmed: false,
      created_at: '2026-09-03T10:00:00.000Z',
      valid_until: null,
      content: 'The user prefers pnpm for JavaScript projects.',
    },
    {
      id: 'mem_01J5G0Z0Z0Z0Z0Z0Z0Z0Z0Z0Z1',
      key: 'preference.package-manager.dup',
      kind: 'semantic',
      importance: 0.7,
      confirmed: false,
      created_at: '2026-09-02T10:00:00.000Z',
      last_evidenced_at: '2026-09-02T10:00:00.000Z',
      valid_until: '2027-01-01',
      content: 'JS 包管理用 pnpm。',
    },
  ]
}

test('curator prompt carries the catalog block, the same evidence window, and the contract', () => {
  const source = extractDreamSource(snapshot(), undefined, {
    cutoffMs: 0,
    maxMessages: 10,
    maxMessageChars: 200,
  })
  const fitted = buildDreamPrompt([source], { maxTranscriptBytes: 4096, maxMemories: 4, maxContentChars: 500 })
  const prompt = buildCuratorPrompt({ catalog: curatorCatalog(), evidenceLines: fitted.lines })
  assert.ok(prompt.includes('BEGIN UNTRUSTED CATALOG NDJSON'))
  assert.ok(prompt.includes('BEGIN UNTRUSTED NDJSON'))
  assert.ok(prompt.includes('"id":"mem_01J5G0Z0Z0Z0Z0Z0Z0Z0Z0Z0Z0"'))
  assert.ok(prompt.includes('"valid_until":"2027-01-01"'), 'valid_until surfaces as null or a date')
  assert.ok(prompt.includes('when unsure, keep'))
  // The evidence window is byte-identical to the extractor's.
  const evidenceBlock = prompt.split('BEGIN UNTRUSTED NDJSON\n')[1]?.split('\nEND UNTRUSTED NDJSON')[0]
  assert.equal(evidenceBlock, fitted.lines.join('\n'))
})

test('curator output: grounded refresh passes, fabricated quotes drop, merges dedupe', () => {
  const source = extractDreamSource(snapshot(), undefined, {
    cutoffMs: 0,
    maxMessages: 10,
    maxMessageChars: 200,
  })
  const fitted = buildDreamPrompt([source], { maxTranscriptBytes: 4096, maxMemories: 4, maxContentChars: 500 })
  const result = parseCuratorOutput(JSON.stringify({
    refresh: [
      { id: 'mem_01J5G0Z0Z0Z0Z0Z0Z0Z0Z0Z0Z0', evidence: { sessionId: 'session-user', seq: 3, quote: 'always use pnpm' } },
      { id: 'mem_01J5G0Z0Z0Z0Z0Z0Z0Z0Z0Z0Z0', evidence: { sessionId: 'session-user', seq: 3, quote: 'always use pnpm' } },
      { id: 'mem_01J5G0Z0Z0Z0Z0Z0Z0Z0Z0Z0Z1', evidence: { sessionId: 'session-user', seq: 3, quote: 'fabricated quote text' } },
      { id: 'mem_missing', evidence: { sessionId: 'session-user', seq: 99, quote: 'always use pnpm' } },
    ],
    merge: [
      { survivor: 'mem_01J5G0Z0Z0Z0Z0Z0Z0Z0Z0Z0Z0', absorbed: 'mem_01J5G0Z0Z0Z0Z0Z0Z0Z0Z0Z0Z1' },
      { survivor: 'mem_01J5G0Z0Z0Z0Z0Z0Z0Z0Z0Z0Z0', absorbed: 'mem_01J5G0Z0Z0Z0Z0Z0Z0Z0Z0Z0Z1' },
      { survivor: 'mem_x', absorbed: 'mem_x' },
    ],
    keep: ['mem_keepme', 42],
  }), fitted.evidence)
  assert.equal(result.refresh.length, 1, 'duplicate refresh + ungrounded refresh drop')
  assert.equal(result.refresh[0]?.id, 'mem_01J5G0Z0Z0Z0Z0Z0Z0Z0Z0Z0Z0')
  assert.match(result.refresh[0]?.quoteHash ?? '', /^sha256:[0-9a-f]{64}$/)
  assert.equal(result.merge.length, 1, 'duplicate and self merges drop')
  assert.deepEqual(result.keep, ['mem_keepme'])
  assert.equal(result.rejected, 6, '3 refresh + 2 merge + 1 keep proposals dropped')

  assert.throws(() => parseCuratorOutput('not json', fitted.evidence), SyntaxError)
  assert.throws(() => parseCuratorOutput('{"refresh":[],"merge":[],"keep":[],"extra":1}', fitted.evidence), /only refresh\/merge\/keep/)
  assert.throws(() => parseCuratorOutput('{"refresh":{},"merge":[],"keep":[]}', fitted.evidence), /must all be arrays/)
  // Empty catalog decisions are fine — an all-keep night is a valid outcome.
  const quiet = parseCuratorOutput('{"refresh":[],"merge":[],"keep":[]}', fitted.evidence)
  assert.deepEqual(quiet, { refresh: [], merge: [], keep: [], rejected: 0 })
})
