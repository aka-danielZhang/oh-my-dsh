/**
 * Browser half: mounts the usageStats Remote contribution and registers the
 * settings section page (dsh-web-search-toggle's client posture).
 *
 * @module dsh-usage-stats/client
 */
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import TYPERT_REMOTE from '../typert.remote-client.ts'
import { UsageStatsSection } from './UsageStatsSection.tsx'
import type { UsageStatsFace } from './UsageStatsSection.tsx'
import { en, zh } from './locales.ts'
import type { UsageStatsLocaleKey } from './locales.ts'
import type { Translate } from './format.ts'

/** Dictionary namespace owned by this plugin. */
const NS = 'usage-stats'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** usage-stats settings page copy. */
    'usage-stats': UsageStatsLocaleKey
  }
}

/** Structural view of the mounted Remote namespace (instance-agnostic). */
interface UsageStatsRemote {
  summary(): Promise<RemoteOutcome<import('../types.ts').UsageStatsSummary>>
  daily(params: { range: 7 | 30 }): Promise<RemoteOutcome<import('../types.ts').UsageStatsDaily>>
  activity(params: { mode: 'daily' | 'weekly' | 'cumulative' }): Promise<RemoteOutcome<import('../types.ts').UsageStatsActivity>>
  breakdown(params: { dim: 'model' | 'provider', range?: 7 | 30 }): Promise<RemoteOutcome<import('../types.ts').UsageStatsBreakdown>>
}

/** RemoteResult flattened to the two shapes the face needs. */
type RemoteOutcome<Value> =
  | { ok: true, value: Value }
  | { ok: false, error: { code: string, message: string } }

/**
 * Required Client services: the apply below awaits ctx.remote.$mount, so the
 * fiber must not run before `remote` arrives. The mounted namespace itself is
 * read through the string-keyed ctx.get (wst's posture).
 */
export const inject = ['slots', 'locale', 'remote']

/** Register the Usage Stats settings section. */
export async function apply(ctx: ClientContext): Promise<() => Promise<void>> {
  // Mount our own generated-equivalent contribution when the shell's
  // selection has not already provided the namespace (mcp-settings pattern).
  const disposeRemote = ctx.get('remote.usageStats') === undefined
    ? await ctx.remote.$mount(TYPERT_REMOTE)
    : async (): Promise<void> => {}
  const remote = ctx.get('remote.usageStats') as UsageStatsRemote | undefined
  if (remote === undefined) {
    await disposeRemote()
    throw new Error('dsh-usage-stats: usageStats Remote did not mount')
  }

  try {
    ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-usage-stats: dictionaries')

    // Registration-time text (the nav label thunk) and the page share one
    // bound translate; copy freshness rides the locale revision.
    const t = ctx.locale.bind(NS) as Translate

    const unwrap = <Value>(outcome: RemoteOutcome<Value>): Value => {
      if (!outcome.ok) throw new Error(`${outcome.error.code}: ${outcome.error.message}`)
      return outcome.value
    }
    const face: UsageStatsFace = {
      summary: async () => unwrap(await remote.summary()),
      daily: async range => unwrap(await remote.daily({ range })),
      activity: async mode => unwrap(await remote.activity({ mode })),
      breakdown: async (dim, range) => unwrap(await remote.breakdown({ dim, range })),
    }

    ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section',
      id: 'usage-stats',
      order: 30,
      label: () => t('nav'),
      inject: (): { face: UsageStatsFace, t: Translate } => ({ face, t }),
    }, UsageStatsSection))
    return disposeRemote
  } catch (error) {
    await disposeRemote()
    throw error
  }
}
