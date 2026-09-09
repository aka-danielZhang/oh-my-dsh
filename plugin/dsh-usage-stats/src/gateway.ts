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
  summarize,
} from './fold.ts'
import { awaitStore } from './shared-store.ts'
import type {
  UsageStatsActivity,
  UsageStatsBreakdown,
  UsageStatsDaily,
  UsageStatsSummary,
} from './types.ts'

/** Structural view of the llm runtime's provider directory (instance-agnostic). */
interface LlmDirectory {
  listProviders(): Array<{ id: string, name: string }>
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
    return summarize(store.aggregates, Date.now(), localUtcOffsetMinutes())
  }

  /**
   * Trend series: one entry per day over the trailing range.
   * @param params - `{ range: 7 | 30 }`.
   */
  @Remote('daily')
  async daily(params: { range: 7 | 30 }): Promise<UsageStatsDaily> {
    const store = await awaitStore()
    await store.rescan()
    return dailySeries(store.aggregates, Date.now(), localUtcOffsetMinutes(), params.range)
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
   * Share slices grouped by provider or model over the trailing range.
   * @param params - `{ dim: 'model' | 'provider', range?: 7 | 30 }` (range
   *   defaults to 30).
   */
  @Remote('breakdown')
  async breakdown(params: { dim: 'model' | 'provider', range?: 7 | 30 }): Promise<UsageStatsBreakdown> {
    const store = await awaitStore()
    await store.rescan()
    const range = params.range ?? 30
    return breakdownOf(
      store.aggregates,
      params.dim,
      Date.now(),
      localUtcOffsetMinutes(),
      range,
      this.providerLabels(),
    )
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
