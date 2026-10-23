/**
 * Shared test helpers: scratch homes, event envelopes, and a small in-memory
 * Quno fixture. Every test writes under its own mkdtemp root; the real
 * `~/.dsh/quno` is never touched.
 *
 * @module dsh-quno/tests/helpers
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_QUNO_CONFIG } from '../src/contracts.ts'
import { QunoStore } from '../src/store.ts'
import type { EventEnvelope, IngestBatch, QunoConfig } from '../src/types.ts'

/** A fresh scratch DSH home. */
export function scratchHome(): string {
  return mkdtempSync(join(tmpdir(), 'quno-test-'))
}

/** One envelope with sane defaults. */
export function envelope(patch: Partial<EventEnvelope> & { eventKey: string; type: string }): EventEnvelope {
  return {
    observedAt: '2026-10-23T09:00:00.000Z',
    summary: `summary for ${patch.eventKey}`,
    data: { key: patch.eventKey },
    ...patch,
  }
}

/** One batch. */
export function batch(events: readonly EventEnvelope[], patch: Partial<IngestBatch> = {}): IngestBatch {
  return {
    batchKey: `batch-${Math.random().toString(36).slice(2)}`,
    events,
    ...patch,
  }
}

/** A store plus the provisioned default Quno. */
export interface Fixture {
  readonly root: string
  readonly store: QunoStore
  readonly now: number
}

/** Open a scratch store and provision the single v1 Quno. */
export function openFixture(config: Partial<QunoConfig> = {}): Fixture {
  const root = scratchHome()
  const store = new QunoStore({ root })
  const now = Date.parse('2026-10-23T09:00:00.000Z')
  store.open(now)
  store.ensureQuno({
    id: 'quno',
    name: 'Quno',
    persona: 'You are Quno.',
    instructions: 'Be concise.',
    config: { ...DEFAULT_QUNO_CONFIG, quietHours: null, ...config },
    now,
  })
  return { root, store, now }
}

/** Register a Sense instance and its stable source. */
export function addSense(fixture: Fixture, type = 'test/calendar', patch: Partial<{
  config: Record<string, unknown>
  desiredState: 'enabled' | 'paused' | 'disabled'
  id: string
}> = {}) {
  const id = patch.id ?? `sense_${Math.random().toString(36).slice(2)}`
  const instance = fixture.store.insertSenseInstance({
    id,
    qunoId: 'quno',
    type,
    label: type,
    config: patch.config ?? {},
    desiredState: patch.desiredState ?? 'enabled',
    now: fixture.now,
  })
  const source = fixture.store.ensureSource(instance, null, fixture.now)
  return { instance, source }
}
