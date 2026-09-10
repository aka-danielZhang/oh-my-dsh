/**
 * Host gateway serving usage statistics over the Typert Remote seam.
 *
 * Every method first awaits the shared store (the collector row publishes it
 * once its initial records rebuild settled — activation order between rows is
 * unconstrained) and then rescans the record files, folding any lines other
 * processes sharing `$DSH_HOME` appended since the last query. Answers are
 * fully aggregated plain JSON; the client never folds raw events.
 *
 * @module dsh-usage-stats/gateway
 */

import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import {
  activityCells,
  breakdownOf,
  dailySeries,
  localUtcOffsetMinutes,
  qualityByModel,
  summarize,
  type UsageStatsRangeSpec,
} from './fold.ts'
import { awaitStore } from './shared-store.ts'
import type {
  UsageStatsActivity,
  UsageStatsBreakdown,
  UsageStatsDaily,
  UsageStatsQuality,
  UsageStatsSummary,
} from './types.ts'

/** Structural view of the llm runtime's provider directory (instance-agnostic). */
interface LlmDirectory {
  listProviders(): Array<{ id: string, name: string }>
}

/** Range selector arriving over the wire (trailing days or explicit dates). */
interface WireRange {
  range?: 7 | 30
  from?: string
  to?: string
}

/** Normalize a wire range into a fold spec (explicit dates win when valid). */
function rangeSpec(args: WireRange): UsageStatsRangeSpec {
  if (typeof args.from === 'string' && typeof args.to === 'string' && args.from !== '' && args.to !== '') {
    return { from: args.from, to: args.to }
  }
  return { days: args.range === 30 ? 30 : 7 }
}

/** Remote gateway over the usage-stats store. */
export class UsageStatsGateway extends TypertRemoteService {
  /** The llm runtime is optional: display names fall back to raw provider ids. */
  static inject: string[] = []

  constructor(ctx: Context) {
    super(ctx, 'usageStats')
  }

  /** The five headline cards. */
  @Remote('summary')
  async summary(): Promise<UsageStatsSummary> {
    const store = await awaitStore()
    await store.rescan()
    return {
      ...summarize(store.aggregates, Date.now(), localUtcOffsetMinutes()),
      ...store.metrics,
    }
  }

  /**
   * Trend series: one entry per day over the requested range.
   * @param params - `{ range?: 7 | 30 }` or `{ from, to }` local dates.
   */
  @Remote('daily')
  async daily(params: WireRange): Promise<UsageStatsDaily> {
    const store = await awaitStore()
    await store.rescan()
    return dailySeries(store.aggregates, Date.now(), localUtcOffsetMinutes(), rangeSpec(params))
  }

  /**
   * Heatmap cells over the trailing ~52 weeks.
   * @param params - `{ mode: 'daily' | 'weekly' | 'cumulative' }`.
   */
  @Remote('activity')
  async activity(params: { mode: 'daily' | 'weekly' | 'cumulative' }): Promise<UsageStatsActivity> {
    const store = await awaitStore()
    await store.rescan()
    return activityCells(store.aggregates, params.mode, Date.now(), localUtcOffsetMinutes())
  }

  /**
   * Share slices grouped by provider or model over the requested range.
   * @param params - `{ dim?: 'model' | 'provider' }` plus a range as in daily.
   */
  @Remote('breakdown')
  async breakdown(params: WireRange & { dim?: 'model' | 'provider' }): Promise<UsageStatsBreakdown> {
    const store = await awaitStore()
    await store.rescan()
    return breakdownOf(
      store.aggregates,
      params.dim === 'provider' ? 'provider' : 'model',
      Date.now(),
      localUtcOffsetMinutes(),
      rangeSpec(params),
      this.providerLabels(),
    )
  }

  /**
   * Per-model cache-hit and apparent-rate grouped bars over the requested range.
   * @param params - a range as in daily.
   */
  @Remote('quality')
  async quality(params: WireRange): Promise<UsageStatsQuality> {
    const store = await awaitStore()
    await store.rescan()
    return qualityByModel(store.aggregates, Date.now(), localUtcOffsetMinutes(), rangeSpec(params))
  }

  /** Provider id → display name, resolved through the live llm runtime when present. */
  private providerLabels(): Map<string, string> {
    const llm = this.ctx.get('llm') as LlmDirectory | undefined
    try {
      const providers = llm?.listProviders() ?? []
      return new Map(providers.map(provider => [provider.id, provider.name]))
    } catch {
      return new Map()
    }
  }
}

export default UsageStatsGateway
