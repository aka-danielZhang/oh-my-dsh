import assert from 'node:assert/strict'
import test from 'node:test'
import { checkDeliveryPresence, checkSemanticPurity, type PurityEvent } from '../src/purity.ts'

function titleEvent(seq: number, title: string): PurityEvent {
  return { seq, type: 'session/title', data: { title } }
}

function messageEvent(seq: number, id: string): PurityEvent {
  return { seq, type: 'user/message', data: { id } }
}

function spliceEvent(seq: number, ...ids: string[]): PurityEvent {
  return {
    seq,
    type: 'agent/inbox/spliced',
    data: { inserted: ids.map(id => ({ id })) },
  }
}

test('any number of session/title events never violates purity', () => {
  // The incident shape: a truncating rename plus a second title event. Titles
  // are log-only presentation metadata; they can never authenticate or
  // de-pristine a target.
  const events = [
    titleEvent(1, 'truncated…'),
    titleEvent(2, 'renamed again'),
    titleEvent(3, '深'.repeat(27)),
  ]
  assert.deepEqual(checkSemanticPurity(events, new Set()), { ok: true })
})

test('model/selection and other log-only events stay allowed', () => {
  const events: PurityEvent[] = [
    { seq: 1, type: 'model/selection', data: { provider: 'pi-ai', model: 'glm-5.3-flash' } },
    { seq: 2, type: 'session/metadata', data: {} },
  ]
  assert.deepEqual(checkSemanticPurity(events, new Set()), { ok: true })
})

test('foreign semantic input diverges with the offending event type', () => {
  for (const type of ['user/message', 'turn/start', 'assistant/message', 'tool/call', 'command/run']) {
    const decision = checkSemanticPurity([{ seq: 1, type, data: {} }], new Set())
    assert.deepEqual(decision, { ok: false, offending: type }, type)
  }
})

test('foreign inbox splice diverges; own splice does not', () => {
  const own = new Set(['handoff-1'])
  assert.deepEqual(checkSemanticPurity([spliceEvent(1, 'handoff-1')], own), { ok: true })
  assert.deepEqual(
    checkSemanticPurity([spliceEvent(1, 'handoff-1', 'user-typed-1')], own),
    { ok: false, offending: 'agent/inbox/spliced' },
  )
})

test('own delivered messages and their downstream turn are not divergence', () => {
  const known = new Set(['handoff-1', 'instruction-1'])
  const events = [
    spliceEvent(1, 'handoff-1'),
    spliceEvent(2, 'instruction-1'),
    messageEvent(3, 'handoff-1'),
    messageEvent(4, 'instruction-1'),
    { seq: 5, type: 'turn/start', data: {} },
    { seq: 6, type: 'assistant/message', data: { id: 'a-1' } },
    { seq: 7, type: 'tool/call', data: {} },
    { seq: 8, type: 'turn/end', data: {} },
  ]
  assert.deepEqual(checkSemanticPurity(events, known), { ok: true })
})

test('delivery presence is decided per message id', () => {
  const both = [spliceEvent(1, 'handoff-1'), messageEvent(2, 'instruction-1')]
  assert.deepEqual(checkDeliveryPresence(both, 'handoff-1', 'instruction-1'), {
    handoffPresent: true,
    instructionPresent: true,
    delivered: true,
  })

  const none = [titleEvent(1, 't')]
  assert.deepEqual(checkDeliveryPresence(none, 'handoff-1', 'instruction-1'), {
    handoffPresent: false,
    instructionPresent: false,
    delivered: false,
  })

  // Partial persistence (crash mid-flush): only what is missing re-delivers.
  const partial = [messageEvent(1, 'handoff-1')]
  assert.deepEqual(checkDeliveryPresence(partial, 'handoff-1', 'instruction-1'), {
    handoffPresent: true,
    instructionPresent: false,
    delivered: false,
  })

  // No recorded ids yet: nothing can be "present".
  assert.deepEqual(checkDeliveryPresence(both, null, null).delivered, false)
})

test('purity with known ids ignores foreign input that predates the delivery', () => {
  // foreign message BEFORE our landed handoff: still divergence — our own
  // presence never masks input that came first.
  const known = new Set(['instruction-1'])
  const events = [messageEvent(1, 'user-typed-9'), messageEvent(2, 'instruction-1')]
  assert.deepEqual(checkSemanticPurity(events, known), { ok: false, offending: 'user/message' })
})
