/**
 * Usage-stats settings section: four headline cards, the activity heatmap
 * with mode tabs, and a standalone range filter (naked row, no card chrome —
 * it visibly governs the two boards below it, the per-model trend and the
 * model-usage donut) supporting trailing 7/30 days or an explicit date span.
 *
 * Data arrives through the injected face (./index.ts binds it to the Typert
 * Remote gateway); the component holds plain useState snapshots and refetches
 * on mount, on tab/range changes, on the Refresh button, and on window focus
 * (the design note's v1 freshness posture — no pushed events yet).
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  UsageStatsActivity,
  UsageStatsBreakdown,
  UsageStatsDaily,
  UsageStatsSummary,
} from '../types.ts'
import type { UsageStatsRangeSpec } from '../fold.ts'
import { ActivityHeatmap, DonutChart, TrendChart, seriesColor } from './charts.tsx'
import { formatDuration, formatRelative, formatTokens, type Translate } from './format.ts'
import styles from './UsageStatsSection.module.css'

/** Range selector shared by the trend and donut boards. */
export interface UsageStatsRange {
  range?: 7 | 30
  from?: string
  to?: string
}

/** Query face bound by the client plugin body (./index.ts). */
export interface UsageStatsFace {
  summary(): Promise<UsageStatsSummary>
  daily(range: UsageStatsRange): Promise<UsageStatsDaily>
  activity(mode: UsageStatsActivity['mode']): Promise<UsageStatsActivity>
  breakdown(range: UsageStatsRange): Promise<UsageStatsBreakdown>
}

/** Props delivered by the slot outlet (the inject face spread flat). */
export type UsageStatsSectionProps = Partial<InjectFace<{ face: UsageStatsFace, t: Translate }>>

type RangeTab = '7' | '30' | 'custom'

/** Local `yyyy-mm-dd` of N days ago. */
function isoDaysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10)
}

/**
 * The settings page.
 * @param props - the injected face and translator.
 */
export function UsageStatsSection({ face, t }: UsageStatsSectionProps): ReactNode {
  const [summary, setSummary] = useState<UsageStatsSummary | undefined>(undefined)
  const [activity, setActivity] = useState<UsageStatsActivity | undefined>(undefined)
  const [daily, setDaily] = useState<UsageStatsDaily | undefined>(undefined)
  const [breakdown, setBreakdown] = useState<UsageStatsBreakdown | undefined>(undefined)
  const [error, setError] = useState('')
  const [activityMode, setActivityMode] = useState<UsageStatsActivity['mode']>('daily')
  const [range, setRange] = useState<RangeTab>('7')
  const [from, setFrom] = useState(isoDaysAgo(29))
  const [to, setTo] = useState(isoDaysAgo(0))

  const rangeSpec: UsageStatsRangeSpec | null = range === 'custom'
    ? (from !== '' && to !== '' && from <= to ? { from, to } : null)
    : { days: range === '30' ? 30 : 7 }
  const wireRange: UsageStatsRange | null = rangeSpec === null
    ? null
    : ('from' in rangeSpec ? { from: rangeSpec.from, to: rangeSpec.to } : { range: rangeSpec.days === 30 ? 30 : 7 })
  const rangeKey = wireRange === null ? '' : JSON.stringify(wireRange)

  const load = useCallback(async () => {
    if (face === undefined || wireRange === null) return
    try {
      const [nextSummary, nextActivity, nextDaily, nextBreakdown] = await Promise.all([
        face.summary(),
        face.activity(activityMode),
        face.daily(wireRange),
        face.breakdown(wireRange),
      ])
      setError('')
      setSummary(nextSummary)
      setActivity(nextActivity)
      setDaily(nextDaily)
      setBreakdown(nextBreakdown)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [activityMode, face, rangeKey])

  // Initial fetch plus the focus refetch (v1 freshness posture).
  useEffect(() => {
    if (face === undefined) return
    void load()
    const onFocus = (): void => {
      if (document.visibilityState === 'visible') void load()
    }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onFocus)
    return () => {
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onFocus)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- face identity is stable for the fiber's lifetime
  }, [face])

  // One stable palette across the trend and the donut: models sorted by
  // trailing-range volume, colors by that order.
  const colors = useMemo(() => {
    const volumes = new Map<string, number>()
    for (const entry of daily?.days ?? []) {
      for (const { model, tokens } of entry.byModel) {
        volumes.set(model, (volumes.get(model) ?? 0) + tokens)
      }
    }
    const ordered = [...volumes.entries()].sort((a, b) => b[1] - a[1]).map(([model]) => model)
    const map = new Map(ordered.map((model, index) => [model, seriesColor(index)]))
    for (const slice of breakdown?.slices ?? []) {
      if (!map.has(slice.key)) map.set(slice.key, seriesColor(map.size))
    }
    return map
  }, [daily, breakdown])

  if (face === undefined || t === undefined) return null

  const compact = (value: number): string => formatTokens(value, t, true)
  const full = (value: number): string => formatTokens(value, t, false)
  const empty = summary !== undefined && summary.totalTokens === 0
  const refreshButton = (
    <button
      type="button"
      className={styles.iconButton}
      title={t('action.refresh')}
      aria-label={t('action.refresh')}
      onClick={() => { void load() }}
    >
      <svg viewBox="0 0 24 24" width={14} height={14} aria-hidden>
        <path
          d="M17.65 6.35A7.958 7.958 0 0 0 12 4a8 8 0 1 0 8 8h-2.01a6 6 0 1 1-1.75-4.24L13 11h7V4l-2.35 2.35z"
          fill="currentColor"
        />
      </svg>
    </button>
  )
  const tabs = (options: Array<{ id: string, label: string }>, active: string, onSelect: (id: string) => void): ReactNode => (
    <div className={styles.tabs} role="tablist">
      {options.map(option => (
        <button
          key={option.id}
          type="button"
          role="tab"
          aria-selected={option.id === active}
          className={option.id === active ? `${styles.tab} ${styles.tabActive}` : styles.tab}
          onClick={() => { onSelect(option.id) }}
        >
          {option.label}
        </button>
      ))}
    </div>
  )

  return (
    <section className={styles.section}>
      <header className={styles.header}>
        <div>
          <h2 className={styles.title}>{t('page.title')}</h2>
          <p className={styles.intro}>{t('page.intro')}</p>
        </div>
        {refreshButton}
      </header>

      {error !== '' && <p className={styles.error}>{t('state.error', { message: error })}</p>}
      {summary === undefined && <p className={styles.state}>{t('state.loading')}</p>}
      {empty && <p className={styles.state}>{t('state.empty')}</p>}

      {summary !== undefined && !empty && (
        <>
          <p className={styles.generated}>
            {t('state.generated', { time: formatRelative(summary.generatedAt, t) })}
            {summary.activeDays > 0
              ? ` · ${t('card.since', { date: summary.firstDate ?? '—', days: summary.activeDays })}`
              : ''}
          </p>

          <div className={styles.cards}>
            <div className={styles.statCard}>
              <span className={styles.statLabel}>{t('card.totalTokens')}</span>
              <span className={styles.statValue}>{full(summary.totalTokens)}</span>
              <span className={styles.statHint}>{summary.calls !== undefined ? '' : ''}</span>
            </div>
            <div className={styles.statCard}>
              <span className={styles.statLabel}>{t('card.avgCacheHit')}</span>
              <span className={styles.statValue}>
                {summary.cacheHitRate === null ? '—' : Math.round(summary.cacheHitRate * 1000) / 10 + '%'}
              </span>
              <span className={styles.statHint}>{t('card.avgCacheHit.hint')}</span>
            </div>
            <div className={styles.statCard}>
              <span className={styles.statLabel}>{t('card.avgSpeed')}</span>
              <span className={styles.statValue}>
                {summary.speedTokensPerSec === null ? '—' : Math.round(summary.speedTokensPerSec * 10) / 10 + ' tok/s'}
              </span>
              <span className={styles.statHint}>{t('card.avgSpeed.hint')}</span>
            </div>
            <div className={styles.statCard}>
              <span className={styles.statLabel}>{t('card.avgCall')}</span>
              <span className={styles.statValue}>{formatDuration(summary.avgCallMs ?? 0, t!)}</span>
              <span className={styles.statHint}>{t('card.avgCall.hint')}</span>
            </div>
          </div>

          {activity !== undefined && (
            <div className={styles.card}>
              <div className={styles.cardHeader}>
                <h3 className={styles.cardTitle}>{t('heatmap.title')}</h3>
                {tabs([
                  { id: 'daily', label: t('heatmap.mode.daily') },
                  { id: 'weekly', label: t('heatmap.mode.weekly') },
                  { id: 'cumulative', label: t('heatmap.mode.cumulative') },
                ], activityMode, mode => { setActivityMode(mode as UsageStatsActivity['mode']) })}
              </div>
              <ActivityHeatmap
                key={activityMode}
                activity={activity}
                t={t!}
                format={compact}
              />
            </div>
          )}

          <div className={styles.filterRow}>
            <h3 className={styles.filterLabel}>{t('range.title')}</h3>
            <div className={styles.filterControls}>
              {tabs([
                { id: '7', label: t('range.7') },
                { id: '30', label: t('range.30') },
                { id: 'custom', label: t('range.custom') },
              ], range, value => { setRange(value as RangeTab) })}
              {range === 'custom' && (
                <span className={styles.filterDates}>
                  <input
                    type="date"
                    className={styles.dateInput}
                    value={from}
                    onChange={e => { setFrom(e.target.value) }}
                  />
                  <span>→</span>
                  <input
                    type="date"
                    className={styles.dateInput}
                    value={to}
                    onChange={e => { setTo(e.target.value) }}
                  />
                </span>
              )}
            </div>
          </div>

          {daily !== undefined && (
            <div className={styles.card}>
              <div className={styles.cardHeader}>
                <h3 className={styles.cardTitle}>{t('trend.title')}</h3>
              </div>
              <TrendChart key={rangeKey} daily={daily} t={t!} format={compact} colors={colors} />
              <ul className={styles.legend}>
                {[...colors.entries()].map(([model, color]) => (
                  <li key={model} className={styles.legendItem}>
                    <span className={styles.swatch} style={{ background: color }} />
                    {model.slice(model.indexOf('/') + 1)}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {breakdown !== undefined && (
            <div className={styles.card}>
              <div className={styles.cardHeader}>
                <h3 className={styles.cardTitle}>{t('donut.title')}</h3>
              </div>
              {breakdown.slices.length === 0
                ? <p className={styles.state}>{t('donut.empty')}</p>
                : <DonutChart key={rangeKey} breakdown={breakdown} colors={colors} format={compact} />}
            </div>
          )}
        </>
      )}
    </section>
  )
}

/** The date key whose compact token value is being formatted — heatmap hover dates arrive as keys already. */
function unusedPlaceholder(): void { /* removed */ }
void unusedPlaceholder

export default UsageStatsSection
