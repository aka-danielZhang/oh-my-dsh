/**
 * Read-time decay: the shared recency ranking used by the interaction capsule
 * and the agent-facing index views. Extracted from `capsule.ts` when views
 * also needed the weights (a views→capsule import would have been a cycle).
 *
 * Piecewise factor over `age = now − (last_evidenced_at ?? created_at)`:
 *
 * ```text
 * age ≤ H/2        → 1
 * H/2 < age < H    → linear 1 → 0.2
 * H ≤ age < 2H     → linear 0.2 → 0
 * age ≥ 2H         → 0
 * ```
 *
 * Confirmed records never decay (factor ≡ 1). Pure; zero writes — decay is
 * computed at read time, never persisted.
 * @module dsh-ohmymemo/decay
 */

import { defaultStoreConfig } from './schema.ts'
import type { MemoryKind, MemoryRecord, StoreUserConfig } from './types.ts'

/** Read-time decay horizons per kind, in days (see the lifecycle design note). */
export interface DecayHorizons {
  semantic: number
  procedural: number
  episodic: number
}

/** Horizons from the user-editable store config (validated, in days). */
export function decayHorizonsFromConfig(config: StoreUserConfig): DecayHorizons {
  return {
    semantic: config.decay_horizon_days_semantic,
    procedural: config.decay_horizon_days_procedural,
    episodic: config.decay_horizon_days_episodic,
  }
}

/**
 * Piecewise recency factor over `age = now − (last_evidenced_at ?? created_at)`
 * (see the module doc for the curve). Confirmed records never decay.
 */
export function decayFactor(record: Pick<MemoryRecord, 'confirmed' | 'created_at' | 'last_evidenced_at'>, now: Date, horizonDays: number): number {
  if (record.confirmed) return 1
  const base = record.last_evidenced_at ?? record.created_at
  const ageMs = now.getTime() - Date.parse(base)
  const horizonMs = horizonDays * 86_400_000
  if (Number.isNaN(ageMs) || ageMs <= horizonMs / 2) return 1
  if (ageMs >= 2 * horizonMs) return 0
  if (ageMs < horizonMs) return 1 - 0.8 * (ageMs - horizonMs / 2) / (horizonMs / 2)
  return 0.2 * (1 - (ageMs - horizonMs) / horizonMs)
}

/** The decay horizon (days) a kind maps to. */
export function horizonFor(kind: MemoryKind, horizons: DecayHorizons): number {
  return horizons[kind] ?? horizons.semantic
}

/** Capsule/index ranking weight: importance × recency factor. Zero drops nothing by itself. */
export function decayWeight(record: MemoryRecord, now: Date, horizons: DecayHorizons): number {
  return record.importance * decayFactor(record, now, horizonFor(record.kind, horizons))
}

/** Default horizons when a caller has no config at hand (pure helpers only). */
export function defaultDecayHorizons(): DecayHorizons {
  return decayHorizonsFromConfig(defaultStoreConfig())
}
