import assert from 'node:assert/strict'
import { test } from 'node:test'
import { projectTaskActivity } from '../src/activity.ts'

const event = (seq: number, type: string, data: unknown, time = 1000 + seq) => ({ seq, type, data, time })

const TOOL_ARGS = JSON.stringify({
  capability: 'yzj',
  operation: 'im.message.list',
  groupId: 'g1',
  token: 'super-secret-token',
  profile: 'default',
})

/** A realistic slice of an executor session log. */
function log(): readonly ReturnType<typeof event>[] {
  return [
    event(1, 'system/message', { message: { content: [{ type: 'text', text: 'SECRET SYSTEM PROMPT' }] } }),
    event(2, 'turn/start', { turn: 1 }),
    event(3, 'user/message', { content: [{ type: 'text', text: '读取 notes.md 的截止日期' }], source: { kind: 'quno-worker-prompt' } }),
    event(4, 'tool/call', { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: JSON.stringify({ path: 'notes.md' }) }),
    event(5, 'tool/result', { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: '截止日期 2026-11-20' }] } }),
    event(6, 'assistant/message', { turn: 1, step: 2, message: { role: 'assistant', content: [{ type: 'reasoning', text: 'PRIVATE THINKING' }, { type: 'text', text: '读取完成。' }] }, stream: [] }),
    event(7, 'tool/call', { turn: 1, step: 3, callId: 'c2', name: 'quno_cli_call', arguments: TOOL_ARGS }),
    event(8, 'tool/result', { turn: 1, step: 3, message: { role: 'tool', toolCallId: 'c2', content: [{ type: 'text', text: `响应含凭证 accessToken=xyz` }] }, error: { name: 'e', code: 'auth' } }),
    event(9, 'request/header', { header: {} }),
    event(10, 'turn/end', { turn: 1, reason: 'end-turn' }),
  ]
}

test('the record whitelists event types and never leaks system prompts', () => {
  const page = projectTaskActivity(log(), null, 50)
  const serialized = JSON.stringify(page.items)
  assert.ok(!serialized.includes('SECRET SYSTEM PROMPT'))
  assert.ok(!serialized.includes('request/header'))
  // turn markers are projected as diagnostics
  assert.deepEqual(page.items.filter(item => item.kind === 'turn').map(item => (item as { phase: string }).phase), ['start', 'end'])
})

test('assistant text drops reasoning blocks', () => {
  const page = projectTaskActivity(log(), null, 50)
  const says = page.items.filter(item => item.kind === 'worker-say')
  assert.equal(says.length, 1)
  const text = JSON.stringify(says[0])
  assert.ok(text.includes('读取完成'))
  assert.ok(!text.includes('PRIVATE THINKING'))
})

test('tool arguments are redacted and paired with their results', () => {
  const page = projectTaskActivity(log(), null, 50)
  const tools = page.items.filter(item => item.kind === 'tool')
  assert.equal(tools.length, 2, 'both results paired into their calls')
  const cli = tools[1] as { argsSummary: string; isError?: boolean; display: string }
  assert.ok(!cli.argsSummary.includes('super-secret-token'))
  assert.ok(cli.argsSummary.includes('im.message.list'))
  assert.equal(cli.display, 'read-messages')
  assert.equal(cli.isError, true)
})

test('credential-shaped text in results and worker text is scrubbed', () => {
  const page = projectTaskActivity(log(), null, 50)
  const cli = page.items.find(item => item.kind === 'tool' && (item as { tool: string }).tool === 'quno_cli_call') as { resultSummary?: string }
  assert.ok(!JSON.stringify(page.items).includes('accessToken=xyz'))
  assert.ok(cli.resultSummary?.includes('<已脱敏>'))
})

test('pagination is seq-stable and orphan results become continuation entries', () => {
  const page1 = projectTaskActivity(log(), null, 3)
  assert.equal(page1.truncated, true)
  assert.ok(page1.nextCursor !== null)
  const page2 = projectTaskActivity(log(), page1.nextCursor, 3)
  // A fresh head refetch pairs everything; no page ever shifts under the cursor.
  const head = projectTaskActivity(log(), null, 50)
  assert.equal(head.items.filter(item => item.kind === 'tool').length, 2)
  assert.ok(page2.items.length > 0)
})

test('an empty or unknown session projects as explicitly empty', () => {
  const page = projectTaskActivity([], null, 50)
  assert.equal(page.items.length, 0)
  assert.equal(page.truncated, false)
  assert.equal(page.nextCursor, null)
  assert.equal(page.sessionIdentity, null)
})
