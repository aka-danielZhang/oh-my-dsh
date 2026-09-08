import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply } from '../src/index.ts'
import { apply as clientApply, inject, PI_AI_NS } from '../src/client/index.ts'
import {
  choiceOf, entryOf, fingerprints, FETCH_MODELS_LABELS, matchRoute, modelOpFor,
  MODEL_ID_ARIA, withChoice,
} from '../src/client/drafts.ts'
import type { InputChoice, ModelEntry } from '../src/client/drafts.ts'
import { SECTION_CSS, injectStyles } from '../src/client/styles.ts'
import { en, zh } from '../src/client/locales.ts'

test('host half exports a loadable surface entry', () => {
  assert.equal(typeof apply, 'function')
})

test('client half exports a loadable plugin', () => {
  assert.equal(typeof clientApply, 'function')
  assert.ok(Array.isArray(inject))
  for (const service of ['locale', 'settingsScope', 'remote', 'remote.settings']) {
    assert.ok(inject.includes(service), `inject must declare ${service}`)
  }
})

test('dictionaries share one key set', () => {
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort())
})

test('stylesheet injects only through --dsw-* tokens', () => {
  assert.equal(typeof SECTION_CSS, 'string')
  assert.ok(!/--[0-9a-f]{6}/i.test(SECTION_CSS), 'no hard-coded colors')
  assert.ok(!/rgba?\(/i.test(SECTION_CSS), 'no hard-coded rgb colors')
  assert.ok(SECTION_CSS.includes('--dsw-alias-'))
  assert.ok(SECTION_CSS.includes('--dsw-shadow-lv3'))
  assert.equal(typeof injectStyles(), 'function')
})

test('anchors mirror the stock dictionaries they must match', () => {
  assert.equal(MODEL_ID_ARIA.test('模型 ID 3'), true)
  assert.equal(MODEL_ID_ARIA.test('Model ID 12'), true)
  assert.equal(MODEL_ID_ARIA.test('显示名称 3'), false)
  assert.equal(MODEL_ID_ARIA.test('Model ID'), false)
  for (const label of ['获取可用模型', 'Fetch available models']) {
    assert.ok(FETCH_MODELS_LABELS.includes(label), label)
  }
})

test('choiceOf maps stored declarations to picker choices', () => {
  assert.equal(choiceOf({ id: 'm' }), 'inherit')
  assert.equal(choiceOf({ id: 'm', input: ['text', 'image'] }), 'text,image')
  assert.equal(choiceOf({ id: 'm', input: ['image'] }), 'text,image')
  assert.equal(choiceOf({ id: 'm', input: ['text'] }), 'text')
  // An empty or unrecognized declaration states no answer and reads as inherit.
  assert.equal(choiceOf({ id: 'm', input: [] }), 'inherit')
  assert.equal(choiceOf({ id: 'm', input: ['audio'] }), 'inherit')
  assert.equal(choiceOf({ id: 'm', input: 'text,image' }), 'inherit')
})

test('withChoice stores and clears declarations without mutating the row', () => {
  const model: ModelEntry = { id: 'm', name: 'M', contextWindow: 1024, input: ['text', 'image'] }
  const cleared = withChoice(model, 'inherit')
  assert.deepEqual(cleared, { id: 'm', name: 'M', contextWindow: 1024 })
  assert.equal(Object.hasOwn(cleared, 'input'), false)
  assert.deepEqual(withChoice({ id: 'm' }, 'text'), { id: 'm', input: ['text'] })
  assert.deepEqual(withChoice({ id: 'm' }, 'text,image'), { id: 'm', input: ['text', 'image'] })
  assert.deepEqual(model, { id: 'm', name: 'M', contextWindow: 1024, input: ['text', 'image'] })
})

const USER = {
  providers: {
    one: {
      models: [
        { id: 'a', name: 'A' },
        { id: 'b', input: ['text'], contextWindow: 4096 },
        'junk',
      ],
    },
    two: { models: [{ id: 'c' }] },
    presetLike: { baseURL: 'https://x' },
  },
}

test('fingerprints lists only user-owned catalogs with record rows', () => {
  const prints = fingerprints(USER)
  assert.deepEqual(Array.from(prints.keys()).sort(), ['one', 'two'])
  assert.deepEqual(prints.get('one'), [
    { id: 'a', name: 'A' },
    { id: 'b', input: ['text'], contextWindow: 4096 },
  ])
  // Absent section shapes yield an empty map.
  assert.equal(fingerprints(undefined).size, 0)
  assert.equal(fingerprints({}).size, 0)
})

test('matchRoute resolves the unique card whose row ids equal a stored sequence', () => {
  const prints = fingerprints(USER)
  assert.equal(matchRoute(['a', 'b'], prints), 'one')
  // A trailing unsaved blank row is ignored, so saved rows remain editable.
  assert.equal(matchRoute(['a', 'b', ''], prints), 'one')
  // A renamed draft row is not editable from this card.
  assert.equal(matchRoute(['a', 'renamed'], prints), undefined)
  // Length mismatches never match.
  assert.equal(matchRoute(['a'], prints), undefined)
  assert.equal(matchRoute([], prints), undefined)
  // Two routes shipping the same sequence are ambiguous by design.
  const ambiguous = new Map([
    ['x', [{ id: 'a' }, { id: 'b' }]],
    ['y', [{ id: 'a' }, { id: 'b' }]],
  ])
  assert.equal(matchRoute(['a', 'b'], ambiguous), undefined)
})

test('entryOf finds the stored row a screen row addresses', () => {
  const prints = fingerprints(USER)
  assert.deepEqual(entryOf('one', 'b', prints), { id: 'b', input: ['text'], contextWindow: 4096 })
  assert.equal(entryOf('one', 'zz', prints), undefined)
  assert.equal(entryOf(undefined, 'a', prints), undefined)
  assert.equal(entryOf('one', '', prints), undefined)
})

test('modelOpFor builds whole-array ops and refuses no-ops', () => {
  // The write targets the stock editor's own path shape.
  assert.equal(PI_AI_NS, 'llm-pi-ai')
  // A real change carries every sibling row and field verbatim.
  const op = modelOpFor(USER, 'one', 'a', 'text,image')
  assert.deepEqual(op, {
    op: 'set',
    path: ['providers', 'one', 'models'],
    value: [
      { id: 'a', name: 'A', input: ['text', 'image'] },
      { id: 'b', input: ['text'], contextWindow: 4096 },
      'junk',
    ],
  })
  // Restating the stored declaration writes nothing.
  assert.equal(modelOpFor(USER, 'one', 'b', 'text'), undefined)
  // Unsaved rows, unknown providers, and absent sections write nothing.
  assert.equal(modelOpFor(USER, 'one', 'zz', 'text,image'), undefined)
  assert.equal(modelOpFor(USER, 'presetLike', 'a', 'text,image'), undefined)
  assert.equal(modelOpFor(undefined, 'one', 'a', 'text,image'), undefined)

  // Clearing a declaration removes only the input key.
  const cleared = modelOpFor(USER, 'one', 'b', 'inherit')
  assert.deepEqual(cleared?.value[1], { id: 'b', contextWindow: 4096 })
})

test('choice round-trips through withChoice for every option', () => {
  for (const option of ['inherit', 'text', 'text,image'] satisfies readonly InputChoice[]) {
    const next = withChoice({ id: 'm', name: 'M' }, option)
    assert.equal(choiceOf(next), option)
  }
})
