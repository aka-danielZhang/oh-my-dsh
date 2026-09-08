import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply } from '../src/index.ts'
import {
  compatZaiOf,
  entryOf,
  effortsOf,
  fingerprints,
  matchRoute,
  modelOpFor,
  planOf,
  withPlan,
} from '../src/client/drafts.ts'
import type { EditorPlan } from '../src/client/drafts.ts'
import { en, zh } from '../src/client/locales.ts'
import { apply as clientApply, inject, NS, PI_AI_NS } from '../src/client/index.ts'

test('host half exports a loadable surface entry', () => {
  assert.equal(typeof apply, 'function')
})

test('client half exports a loadable plugin', () => {
  assert.equal(typeof clientApply, 'function')
  assert.ok(Array.isArray(inject))
  for (const service of ['locale', 'settingsScope', 'remote', 'remote.settings']) {
    assert.ok(inject.includes(service), `inject must declare ${service}`)
  }
  assert.equal(NS, 'settings.modelEfforts')
  assert.equal(PI_AI_NS, 'llm-pi-ai')
})

test('locales cover the same key sets in both languages', () => {
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort())
})

test('effortsOf reads undeclared, pinned-off, and dict declarations', () => {
  assert.deepEqual(effortsOf({}), { kind: 'undeclared' })
  assert.deepEqual(effortsOf({ reasoningEfforts: false }), { kind: 'false' })
  assert.deepEqual(effortsOf({ reasoningEfforts: {} }), { kind: 'undeclared' })
  assert.deepEqual(
    effortsOf({ reasoningEfforts: { low: 'low', high: 'high' } }),
    { kind: 'levels', levels: { low: 'low', high: 'high' } },
  )
  // An off entry left valueless (YAML `off:` arrives as null) reads as null.
  assert.deepEqual(
    effortsOf({ reasoningEfforts: { off: null, high: 'high' } }),
    { kind: 'levels', levels: { off: null, high: 'high' } },
  )
})

test('compatZaiOf recognizes only both switches set to the zai values', () => {
  assert.equal(compatZaiOf({}), false)
  assert.equal(compatZaiOf({ compat: { supportsReasoningEffort: true } }), false)
  assert.equal(compatZaiOf({
    compat: { supportsReasoningEffort: true, thinkingFormat: 'openai' },
  }), false)
  assert.equal(compatZaiOf({
    compat: { supportsReasoningEffort: true, thinkingFormat: 'zai' },
  }), true)
})

test('withPlan replaces the declaration without touching siblings', () => {
  const base = { id: 'm', name: 'M', contextWindow: 1000 }
  const plan: EditorPlan = { efforts: { kind: 'levels', levels: { low: 'low', max: 'max' } }, compatZai: true }
  const next = withPlan(base, plan)
  assert.deepEqual(next.reasoningEfforts, { low: 'low', max: 'max' })
  assert.deepEqual(next.compat, { supportsReasoningEffort: true, thinkingFormat: 'zai' })
  assert.equal(next.id, 'm')
  // The input is never mutated.
  assert.equal('reasoningEfforts' in base, false)

  // Undeclared removes ONLY the declaration; other compat fields survive.
  const declared = {
    ...base,
    reasoningEfforts: { high: 'high' },
    compat: { supportsReasoningEffort: true, thinkingFormat: 'zai', extra: 1 },
  }
  const cleared = withPlan(declared, { efforts: { kind: 'undeclared' }, compatZai: false })
  assert.equal(cleared.reasoningEfforts, undefined)
  assert.deepEqual(cleared.compat, { extra: 1 })

  // Clearing zai compat on an otherwise-empty compat object drops the key.
  const zaiOnly = { ...base, compat: { supportsReasoningEffort: true, thinkingFormat: 'zai' } }
  assert.equal(withPlan(zaiOnly, { efforts: { kind: 'false' }, compatZai: false }).compat, undefined)
})

test('route anchoring matches stored id sequences uniquely', () => {
  const user = {
    providers: {
      a: { models: [{ id: 'x' }, { id: 'y' }] },
      b: { models: [{ id: 'x' }, { id: 'y' }] },
      c: { models: [{ id: 'z' }] },
    },
  }
  const prints = fingerprints(user)
  assert.equal(matchRoute(['x'], prints), undefined) // ambiguous
  assert.equal(matchRoute(['z'], prints), 'c')
  assert.equal(entryOf('c', 'z', prints), fingerprints(user).get('c')?.[0])
})

const PLAN: EditorPlan = { efforts: { kind: 'levels', levels: { low: 'low', max: 'max' } }, compatZai: true }

test('modelOpFor writes one whole-array op and skips no-ops', () => {
  const user = { providers: { r: { models: [{ id: 'a' }, { id: 'b', reasoningEfforts: { low: 'low' } }] } } }
  const op = modelOpFor(user, 'r', 'a', PLAN)
  assert.ok(op !== undefined)
  assert.deepEqual(op.path, ['providers', 'r', 'models'])
  const models = op.value as Record<string, unknown>[]
  assert.deepEqual(models[0]?.reasoningEfforts, { low: 'low', max: 'max' })
  assert.deepEqual(models[1]?.reasoningEfforts, { low: 'low' }) // untouched row rides along

  // Already carrying the plan → no op. Absent route → no op.
  const updated = { providers: { r: { models: [withPlan({ id: 'a' }, PLAN)] } } }
  assert.equal(modelOpFor(updated, 'r', 'a', PLAN), undefined)
  assert.equal(modelOpFor(user, 'other', 'a', PLAN), undefined)
})

test('modelOpFor diffs by full plan including the compat piece', () => {
  const user = { providers: { r: { models: [{ id: 'a', reasoningEfforts: { low: 'low' } }] } } }
  const compatOnly: EditorPlan = { efforts: { kind: 'levels', levels: { low: 'low' } }, compatZai: true }
  const op = modelOpFor(user, 'r', 'a', compatOnly)
  assert.ok(op !== undefined)
  const written = (op.value as Record<string, unknown>[])[0]
  assert.deepEqual(written?.reasoningEfforts, { low: 'low' })
  assert.deepEqual(written?.compat, { supportsReasoningEffort: true, thinkingFormat: 'zai' })
})

test('planOf round-trips through withPlan unchanged', () => {
  for (const plan of [
    { efforts: { kind: 'undeclared' }, compatZai: false },
    { efforts: { kind: 'false' }, compatZai: true },
    { efforts: { kind: 'levels', levels: { off: null as string | null, high: 'ultra' } }, compatZai: false },
  ] as EditorPlan[]) {
    const next = withPlan({}, plan)
    assert.deepEqual(planOf(next), plan)
  }
})
