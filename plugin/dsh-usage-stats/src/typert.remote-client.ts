/**
 * Generated-equivalent Typert Client contribution owned by dsh-usage-stats
 * (dsh-web-search-toggle's pattern): the single source of truth for the
 * usageStats namespace's wire shape, shared by the browser half's
 * `ctx.remote.$mount` and the Host's strict registration (./typert.host.ts).
 *
 * @module dsh-usage-stats/typert.remote-client
 */
import type { RemoteResult, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'
import type {
  UsageStatsActivity,
  UsageStatsBreakdown,
  UsageStatsDaily,
  UsageStatsSummary,
} from './types.ts'

const summarySchema = z.object({
  totalTokens: z.number(),
  peakTokens: z.number(),
  longestChatMs: z.number(),
  currentStreakDays: z.number(),
  longestStreakDays: z.number(),
  activeDays: z.number(),
  firstDate: z.string().nullable(),
  lastDate: z.string().nullable(),
  calls: z.number(),
  speedTokensPerSec: z.number().nullable(),
  avgCallMs: z.number().nullable(),
  cacheHitRate: z.number().nullable(),
  generatedAt: z.number(),
})

const dailySchema = z.object({
  days: z.array(z.object({
    date: z.string(),
    total: z.number(),
    byModel: z.array(z.object({
      model: z.string(),
      tokens: z.number(),
    })),
  })),
})

const activitySchema = z.object({
  mode: z.enum(['daily', 'weekly', 'cumulative']),
  cells: z.array(z.object({
    date: z.string(),
    total: z.number(),
    calls: z.number(),
    level: z.number(),
  })),
  maxTotal: z.number(),
})

const breakdownSchema = z.object({
  dim: z.enum(['model', 'provider']),
  total: z.number(),
  slices: z.array(z.object({
    key: z.string(),
    label: z.string(),
    tokens: z.number(),
    share: z.number(),
  })),
})

const rangeParamsSchema = z.object({
  range: z.union([z.literal(7), z.literal(30)]).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
})

const activityParamsSchema = z.object({
  mode: z.enum(['daily', 'weekly', 'cumulative']),
})

const breakdownParamsSchema = rangeParamsSchema.extend({
  dim: z.enum(['model', 'provider']).optional(),
})

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespace$75736167655374617473 {
    summary: () => Promise<RemoteResult<UsageStatsSummary>>
    daily: (params: { range?: 7 | 30, from?: string, to?: string }) => Promise<RemoteResult<UsageStatsDaily>>
    activity: (params: { mode: 'daily' | 'weekly' | 'cumulative' }) => Promise<RemoteResult<UsageStatsActivity>>
    breakdown: (params: { dim?: 'model' | 'provider', range?: 7 | 30, from?: string, to?: string }) => Promise<RemoteResult<UsageStatsBreakdown>>
  }
  interface TypertRemoteMap {
    'usageStats/summary': () => Promise<RemoteResult<UsageStatsSummary>>
    'usageStats/daily': (params: { range?: 7 | 30, from?: string, to?: string }) => Promise<RemoteResult<UsageStatsDaily>>
    'usageStats/activity': (params: { mode: 'daily' | 'weekly' | 'cumulative' }) => Promise<RemoteResult<UsageStatsActivity>>
    'usageStats/breakdown': (params: { dim?: 'model' | 'provider', range?: 7 | 30, from?: string, to?: string }) => Promise<RemoteResult<UsageStatsBreakdown>>
  }
  interface TypertRemoteNamespaceMap {
    usageStats: TypertRemoteNamespace$75736167655374617473
  }
}

/** Browser Remote descriptor for the usageStats namespace. */
export const TYPERT_REMOTE: TypertRemoteContribution = {
  package: 'dsh-usage-stats',
  descriptors: [
    {
      id: 'dsh-usage-stats#usageStats/summary',
      service: 'usageStats',
      namespace: 'usageStats',
      method: 'summary',
      invocation: { kind: 'direct' },
      parameters: [],
      result: {
        mode: 'strict',
        typeSymbol: 'dsh-usage-stats/types#UsageStatsSummary',
        schema: summarySchema,
      },
      sourceLocation: { file: 'src/gateway.ts', line: 1, column: 3 },
    },
    {
      id: 'dsh-usage-stats#usageStats/daily',
      service: 'usageStats',
      namespace: 'usageStats',
      method: 'daily',
      invocation: { kind: 'direct' },
      parameters: [{
        name: 'params',
        wire: 'params',
        source: 'json',
        codec: {
          mode: 'strict',
          typeSymbol: 'dsh-usage-stats/types#UsageStatsRangeParams',
          schema: rangeParamsSchema,
        },
      }],
      result: {
        mode: 'strict',
        typeSymbol: 'dsh-usage-stats/types#UsageStatsDaily',
        schema: dailySchema,
      },
      sourceLocation: { file: 'src/gateway.ts', line: 1, column: 3 },
    },
    {
      id: 'dsh-usage-stats#usageStats/activity',
      service: 'usageStats',
      namespace: 'usageStats',
      method: 'activity',
      invocation: { kind: 'direct' },
      parameters: [{
        name: 'params',
        wire: 'params',
        source: 'json',
        codec: {
          mode: 'strict',
          typeSymbol: 'dsh-usage-stats/types#UsageStatsActivityParams',
          schema: activityParamsSchema,
        },
      }],
      result: {
        mode: 'strict',
        typeSymbol: 'dsh-usage-stats/types#UsageStatsActivity',
        schema: activitySchema,
      },
      sourceLocation: { file: 'src/gateway.ts', line: 1, column: 3 },
    },
    {
      id: 'dsh-usage-stats#usageStats/breakdown',
      service: 'usageStats',
      namespace: 'usageStats',
      method: 'breakdown',
      invocation: { kind: 'direct' },
      parameters: [{
        name: 'params',
        wire: 'params',
        source: 'json',
        codec: {
          mode: 'strict',
          typeSymbol: 'dsh-usage-stats/types#UsageStatsBreakdownParams',
          schema: breakdownParamsSchema,
        },
      }],
      result: {
        mode: 'strict',
        typeSymbol: 'dsh-usage-stats/types#UsageStatsBreakdown',
        schema: breakdownSchema,
      },
      sourceLocation: { file: 'src/gateway.ts', line: 1, column: 3 },
    },
  ],
}

export default TYPERT_REMOTE
