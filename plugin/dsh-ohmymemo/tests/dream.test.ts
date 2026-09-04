import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SessionLogSnapshot } from '@deepseek-ai/dsh-session-query'
import {
  buildDreamPrompt,
  cursorWatermarks,
  dueCatchUpBoundary,
  extractDreamSource,
  latestScheduleBoundary,
  nextScheduleBoundary,
  parseDreamOutput,
  parseLocalTime,
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
  const prompt = buildDreamPrompt([source], { maxTranscriptBytes: 4096, maxMemories: 4 })
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
  const prompt = buildDreamPrompt([source], { maxTranscriptBytes: 8, maxMemories: 1 })
  assert.equal(prompt.messageCount, 0)
  assert.equal(prompt.evidence.size, 0)

  const bounded = buildDreamPrompt([source], { maxTranscriptBytes: 150, maxMemories: 1 })
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
