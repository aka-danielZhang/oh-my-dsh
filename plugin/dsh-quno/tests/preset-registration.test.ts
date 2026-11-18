import assert from 'node:assert/strict'
import { test } from 'node:test'
import { inject } from '../src/index.ts'

/**
 * The 2026-11-19 incident: the loader builds plugin entries concurrently, so a
 * lookup-only `agentPresets` raced the registry. The registration was skipped
 * with a warning, `start()` kept running, and every Quno session then failed
 * with "Unknown agent preset: quno" for the rest of the process lifetime —
 * restarts only re-rolled the race. The declaration is what keeps the fiber
 * pending until the registry is mounted, so it must stay a hard dependency.
 */
test('the Host declares the preset registry as a hard dependency', () => {
  assert.ok(inject.includes('agentPresets'))
})
