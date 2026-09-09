/**
 * Usage-stats settings section: the five headline cards, the activity
 * heatmap with mode tabs, a 7/30-day range switch feeding the per-model
 * trend chart and the provider/model donut.
 *
 * Data arrives through the injected face (./index.ts binds it to the Typert
 * Remote gateway); the component holds plain useState snapshots and refetches
 * on mount, on tab/range changes, on the Refresh button, and on window focus
 * (the design note's v1 freshness posture — no pushed events yet).
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  UsageStatsActivity,
  UsageStatsBreakdown,
  UsageStatsDaily,
  UsageStatsSummary,
} from '../types.ts'
import { ActivityHeatmap, DonutChart, HeatLegend, TrendChart, seriesColor } from './charts.tsx'
import { formatDuration, formatRelative, formatShare, formatTokens, group, type Translate } from './format.ts'
import type { UsageStatsLocaleKey } from './locales.ts'
import styles from './UsageStatsSection.module.css'

/** Query face bound by the client plugin body (./index.ts). */
export interface UsageStatsFace {
  summary(): Promise<UsageStatsSummary>
  daily(range: 7 | 30): Promise<UsageStatsDaily>
  activity(mode: UsageStatsActivity['mode']): Promise<UsageStatsActivity>
  breakdown(dim: UsageStatsBreakdown['dim'], range?: 7 | 30): Promise<UsageStatsBreakdown>
}

/** Props delivered by the slot outlet (the inject face spread flat). */
export type UsageStatsSectionProps = Partial<InjectFace<{ face: UsageStatsFace, t: Translate }>>

type Status = 'loading' | 'ready' | 'error'

interface PageState {
  status: Status
  error: string
  summary: UsageStatsSummary | undefined
  activity: UsageStatsActivity | undefined
  activityMode: UsageStatsActivity['mode']
  daily: UsageStatsDaily | undefined
  range: 7 | 30
  breakdown: UsageStatsBreakdown | undefined
  breakdownDim: UsageStatsBreakdown['dim']
}

/**
 * The settings page.
 * @param props - the injected face and translator.
 */
export function UsageStatsSection({ face, t }: UsageStatsSectionProps): ReactNode {
  const [state, setState] = useState<PageState>({
    status: 'loading',
    error: '',
    summary: undefined,
    activity: undefined,
    activityMode: 'daily',
    daily: undefined,
    range: 30,
    breakdown: undefined,
    breakdownDim: 'model',
  })

  const applyError = useCallback((error: unknown, current: PageState): PageState => ({
    ...current,
    status: 'error',
    error: error instanceof Error ? error.message : String(error),
  }), [])

  const loadAll = useCallback(async () => {
    setState(current => ({ ...current, status: 'loading' }))
    try {
      const [summary, activity, daily, breakdown] = await Promise.all([
        face!.summary(),
        face!.activity(state.activityMode),
        face!.daily(state.range),
        face!.breakdown(state.breakdownDim, state.range),
      ])
      setState({
        status: 'ready',
        error: '',
        summary,
        activity,
        activityMode: state.activityMode,
        daily,
        range: state.range,
        breakdown,
        breakdownDim: state.breakdownDim,
      })
    } catch (error) {
      setState(current => applyError(error, current))
    }
  }, [applyError, face, state.activityMode, state.breakdownDim, state.range])

  // Initial fetch plus the focus refetch (v1 freshness posture).
  useEffect(() => {
    if (face === undefined) return
    void loadAll()
    const onFocus = (): void => {
      if (document.visibilityState === 'visible') void loadAll()
    }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onFocus)
    return () => {
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onFocus)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- face identity is stable for the fiber's lifetime
  }, [face])

  const setActivityMode = useCallback(async (mode: UsageStatsActivity['mode']) => {
    setState(current => ({ ...current, activityMode: mode }))
    try {
      const activity = await face!.activity(mode)
      setState(current => (current.activityMode === mode ? { ...current, activity } : current))
    } catch (error) {
      setState(current => applyError(error, current))
    }
  }, [applyError, face])

  const setRange = useCallback(async (range: 7 | 30) => {
    setState(current => ({ ...current, range }))
    try {
      const [daily, breakdown] = await Promise.all([
        face!.daily(range),
        face!.breakdown(state.breakdownDim, range),
      ])
      setState(current => (current.range === range ? { ...current, daily, breakdown } : current))
    } catch (error) {
      setState(current => applyError(error, current))
    }
  }, [applyError, face, state.breakdownDim])

  const setBreakdownDim = useCallback(async (dim: UsageStatsBreakdown['dim']) => {
    setState(current => ({ ...current, breakdownDim: dim }))
    try {
      const breakdown = await face!.breakdown(dim, state.range)
      setState(current => (current.breakdownDim === dim ? { ...current, breakdown } : current))
    } catch (error) {
      setState(current => applyError(error, current))
    }
  }, [applyError, face, state.range])

  // One stable palette across the trend and the donut: models sorted by
  // trailing-range volume, colors by that order.
  const colors = useMemo(() => {
    const volumes = new Map<string, number>()
    for (const entry of state.daily?.days ?? []) {
      for (const { model, tokens } of entry.byModel) {
        volumes.set(model, (volumes.get(model) ?? 0) + tokens)
      }
    }
    const ordered = [...volumes.entries()].sort((a, b) => b[1] - a[1]).map(([model]) => model)
    const map = new Map(ordered.map((model, index) => [model, seriesColor(index)]))
    for (const slice of state.breakdown?.slices ?? []) {
      if (!map.has(slice.key)) map.set(slice.key, seriesColor(map.size))
    }
    return map
  }, [state.daily, state.breakdown])

  if (face === undefined) return null

  const compact = (value: number): string => formatTokens(value, t!, true)
  const full = (value: number): string => formatTokens(value, t!, false)
  const { summary, activity, daily, breakdown } = state
  const empty = state.status === 'ready' && summary !== undefined && summary.totalTokens === 0

  return (
    <section className={styles.section}>
      <header className={styles.header}>
        <div>
          <h2 className={styles.title}>{t!('page.title')}</h2>
          <p className={styles.intro}>{t!('page.intro')}</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => { void loadAll() }}>
          {t!('action.refresh')}
        </Button>
      </header>

      {state.status === 'loading' && <p className={styles.state}>{t!('state.loading')}</p>}
      {state.status === 'error' && (
        <p className={styles.error}>{t!('state.error', { message: state.error })}</p>
      )}

      {empty && <p className={styles.state}>{t!('state.empty')}</p>}

      {state.status === 'ready' && !empty && summary !== undefined && (
        <>
          <p className={styles.generated}>
            {t!('state.generated', { time: formatRelative(summary.generatedAt, t!) })}
            {summary.activeDays > 0
              ? ` · ${t!('card.since', { date: summary.firstDate ?? '—', days: summary.activeDays })}`
              : ''}
          </p>

          <div className={styles.cards}>
            <StatCard label={t!('card.totalTokens')} value={full(summary.totalTokens)} />
            <StatCard label={t!('card.peakTokens')} value={compact(summary.peakTokens)} hint={t!('card.peakTokens.hint')} />
            <StatCard label={t!('card.longestChat')} value={formatDuration(summary.longestChatMs, t!)} />
            <StatCard
              label={t!('card.currentStreak')}
              value={`${summary.currentStreakDays} ${t!('card.unit.days')}`}
              hint={t!('card.currentStreak.hint')}
            />
            <StatCard
              label={t!('card.longestStreak')}
              value={`${summary.longestStreakDays} ${t!('card.unit.days')}`}
            />
          </div>

          {activity !== undefined && (
            <div className={styles.card}>
              <CardHeader title={t!('heatmap.title')}>
                <TabGroup
                  options={[
                    { id: 'daily', label: t!('heatmap.mode.daily') },
                    { id: 'weekly', label: t!('heatmap.mode.weekly') },
                    { id: 'cumulative', label: t!('heatmap.mode.cumulative') },
                  ]}
                  active={state.activityMode}
                  onSelect={mode => { void setActivityMode(mode as UsageStatsActivity['mode']) }}
                />
              </CardHeader>
              <div className={styles.heatmapScroll}>
                <ActivityHeatmap activity={activity} t={t!} format={compact} />
              </div>
              <HeatLegend activity={activity} t={t!} format={compact} />
            </div>
          )}

          {daily !== undefined && breakdown !== undefined && (
            <div className={styles.card}>
              <CardHeader title={t!('trend.title')}>
                <TabGroup
                  options={[
                    { id: '7', label: t!('range.7') },
                    { id: '30', label: t!('range.30') },
                  ]}
                  active={String(state.range)}
                  onSelect={value => { void setRange(value === '7' ? 7 : 30) }}
                />
              </CardHeader>
              <TrendChart daily={daily} t={t!} format={compact} colors={colors} />
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
              <CardHeader title={t!('donut.title')}>
                <TabGroup
                  options={[
                    { id: 'model', label: t!('donut.dim.model') },
                    { id: 'provider', label: t!('donut.dim.provider') },
                  ]}
                  active={state.breakdownDim}
                  onSelect={dim => { void setBreakdownDim(dim as UsageStatsBreakdown['dim']) }}
                />
              </CardHeader>
              {breakdown.slices.length === 0
                ? <p className={styles.state}>{t!('donut.empty')}</p>
                : (
                  <div className={styles.donutRow}>
                    <div className={styles.donutWrap}>
                      <DonutChart breakdown={breakdown} colors={colors} />
                      <span className={styles.donutTotal}>{compact(breakdown.total)}</span>
                    </div>
                    <ul className={styles.slices}>
                      {breakdown.slices.map(slice => (
                        <li key={slice.key} className={styles.slice}>
                          <span className={styles.swatch} style={{ background: colors.get(slice.key) ?? seriesColor(0) }} />
                          <span className={styles.sliceLabel} title={slice.key}>{slice.label}</span>
                          <span className={styles.sliceValue}>
                            {t!('donut.share', { share: formatShare(slice.share), tokens: group(slice.tokens) })}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
            </div>
          )}
        </>
      )}
    </section>
  )
}

/** One headline stat tile. */
function StatCard({ label, value, hint }: { label: string, value: string, hint?: string }): ReactNode {
  return (
    <div className={styles.statCard}>
      <span className={styles.statLabel}>{label}</span>
      <span className={styles.statValue}>{value}</span>
      {hint !== undefined && <span className={styles.statHint}>{hint}</span>}
    </div>
  )
}

/** Card title row with trailing controls. */
function CardHeader({ title, children }: { title: string, children?: ReactNode }): ReactNode {
  return (
    <div className={styles.cardHeader}>
      <h3 className={styles.cardTitle}>{title}</h3>
      {children}
    </div>
  )
}

/** Small segmented control. */
function TabGroup({ options, active, onSelect }: {
  options: Array<{ id: string, label: string }>
  active: string
  onSelect: (id: string) => void
}): ReactNode {
  return (
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
}

export default UsageStatsSection
