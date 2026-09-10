/**
 * Usage-stats settings page — a quiet single-column stats panel:
 * header → summary band → activity heatmap → range toolbar → stacked daily
 * trend → model-usage donut & ranking.
 *
 * Requests live in THREE independent groups (summary / activity / range),
 * each with its own generation counter so a fast switch can never let a stale
 * response overwrite a newer selection, and each failing alone: one group's
 * error renders in its own section with a retry, never blanking the others.
 * While refetching, the previous data stays on screen behind a busy state.
 * The face and translator arrive through the slot inject; `lang()` resolves
 * the formatter profile at render time (locale switches re-render the outlet).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, IconRefreshOutline16, Pill, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  UsageStatsActivity,
  UsageStatsBreakdown,
  UsageStatsDaily,
  UsageStatsSummary,
} from '../types.ts'
import { ActivityHeatmap, DonutChart, LegendRow, TrendChart } from './charts.tsx'
import { breakdownCut, cutNamed, modelTotalsOf } from './chart-data.ts'
import {
  daysBetween,
  formatDateWithImplicitYear,
  formatDuration,
  formatPercent,
  formatRelative,
  formatSpeed,
  formatTokens,
  localDaysAgoKey,
} from './format.ts'
import type { UsageStatsLang } from './format.ts'
import type { UsageStatsLocaleKey } from './locales.ts'
import styles from './UsageStatsSection.module.css'

/** Range selector shared by the trend and donut boards. */
export interface UsageStatsRange {
  range?: 7 | 30
  from?: string
  to?: string
}

/** Translator bound by the page (replaces `{placeholder}` segments). */
export type Translate = (key: UsageStatsLocaleKey, params?: Record<string, string | number>) => string

/** Query face bound by the client plugin body (./index.ts). */
export interface UsageStatsFace {
  summary(): Promise<UsageStatsSummary>
  daily(range: UsageStatsRange): Promise<UsageStatsDaily>
  activity(mode: UsageStatsActivity['mode']): Promise<UsageStatsActivity>
  breakdown(range: UsageStatsRange): Promise<UsageStatsBreakdown>
  quality(range: UsageStatsRange): Promise<{ models: unknown[] }>
}

/** Props delivered by the slot outlet (the inject face spread flat). */
export type UsageStatsSectionProps = Partial<InjectFace<{
  face: UsageStatsFace
  t: Translate
  lang: () => UsageStatsLang
}>>

type RangeTab = '7' | '30' | 'custom'
type ActivityMode = UsageStatsActivity['mode']

/** One request group: latest data, busy flag, and a section-local error. */
interface Group<D> {
  data?: D
  loading: boolean
  error?: string
}

const INITIAL: Group<never> = { loading: true }

/** Why a custom range is not queryable right now. */
type RangeIssue = { key: 'range.missing' | 'range.invalid' } | { key: 'range.tooLong', days: number }

/**
 * The settings page.
 * @param props - the injected face, translator, and language resolver.
 */
export function UsageStatsSection({ face, t, lang }: UsageStatsSectionProps): ReactNode {
  const [summaryState, setSummaryState] = useState<Group<UsageStatsSummary>>(INITIAL)
  const [activityState, setActivityState] = useState<Group<UsageStatsActivity>>(INITIAL)
  const [rangeState, setRangeState] = useState<Group<{ daily: UsageStatsDaily, breakdown: UsageStatsBreakdown }>>(INITIAL)
  const [activityMode, setActivityMode] = useState<ActivityMode>('daily')
  const [range, setRange] = useState<RangeTab>('7')
  const [from, setFrom] = useState(() => localDaysAgoKey(29))
  const [to, setTo] = useState(() => localDaysAgoKey(0))
  const [announce, setAnnounce] = useState('')

  const summaryGen = useRef(0)
  const activityGen = useRef(0)
  const rangeGen = useRef(0)
  const mounted = useRef(false)

  const rangeIssue: RangeIssue | null = useMemo(() => {
    if (range !== 'custom') return null
    if (from === '' || to === '') return { key: 'range.missing' }
    const span = daysBetween(from, to)
    if (Number.isNaN(span)) return { key: 'range.missing' }
    if (span < 0) return { key: 'range.invalid' }
    if (span > 120) return { key: 'range.tooLong', days: span + 1 }
    return null
  }, [range, from, to])

  const wireRange: UsageStatsRange | null = useMemo(() => {
    if (rangeIssue !== null) return null
    if (range === 'custom') return { from, to }
    return { range: range === '30' ? 30 : 7 }
  }, [range, rangeIssue, from, to])

  const loadSummary = useCallback(async (): Promise<void> => {
    if (face === undefined) return
    const gen = ++summaryGen.current
    setSummaryState(state => ({ ...state, loading: true }))
    try {
      const data = await face.summary()
      if (gen !== summaryGen.current) return
      setSummaryState({ data, loading: false })
    } catch (error) {
      if (gen !== summaryGen.current) return
      setSummaryState({ error: messageOf(error), loading: false })
    }
  }, [face])

  const loadActivity = useCallback(async (): Promise<void> => {
    if (face === undefined) return
    const gen = ++activityGen.current
    setActivityState(state => ({ ...state, loading: true }))
    try {
      const data = await face.activity(activityMode)
      if (gen !== activityGen.current) return
      setActivityState({ data, loading: false })
    } catch (error) {
      if (gen !== activityGen.current) return
      setActivityState({ error: messageOf(error), loading: false })
    }
  }, [activityMode, face])

  const loadRange = useCallback(async (): Promise<void> => {
    if (face === undefined || wireRange === null) return
    const gen = ++rangeGen.current
    setRangeState(state => ({ ...state, loading: true }))
    try {
      // quality rides the same generation (kept on the wire for future use;
      // the page itself renders only daily + breakdown).
      const [daily, breakdown] = await Promise.all([
        face.daily(wireRange),
        face.breakdown(wireRange),
        face.quality(wireRange).catch(() => undefined),
      ])
      if (gen !== rangeGen.current) return
      setRangeState({ data: { daily, breakdown }, loading: false })
    } catch (error) {
      if (gen !== rangeGen.current) return
      setRangeState({ error: messageOf(error), loading: false })
    }
  }, [face, wireRange])

  const loadAll = useCallback(async (options?: { announce?: boolean }): Promise<void> => {
    await Promise.allSettled([
      loadSummary(),
      loadActivity(),
      rangeIssue === null ? loadRange() : Promise.resolve(),
    ])
    // Only an explicit refresh announces — the initial load and the focus
    // refetch stay silent (a page that keeps talking is not quiet).
    if (options?.announce === true) setAnnounce(t?.('state.refreshed') ?? '')
  }, [loadActivity, loadRange, loadSummary, rangeIssue, t])

  // Initial parallel load of all three groups, plus the v1 freshness
  // posture: refetch everything when the window regains focus.
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- identity of the face is stable for the fiber's lifetime
  }, [face])

  // Mode / range switches reload ONLY their group. The initial effect above
  // already covers the first commit, so these skip it.
  useEffect(() => {
    if (!mounted.current) return
    void loadActivity()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- activityMode identity drives this
  }, [activityMode])

  useEffect(() => {
    if (!mounted.current) return
    if (rangeIssue !== null) {
      ++rangeGen.current
      setRangeState({ data: undefined, loading: false, error: undefined })
      return
    }
    void loadRange()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the serialized range identity drives this
  }, [range === 'custom' ? `custom:${from}:${to}` : range])

  useEffect(() => {
    mounted.current = true
  }, [])

  if (face === undefined || t === undefined || lang === undefined) return null

  const language = lang()
  const summary = summaryState.data
  const empty = summary !== undefined && summary.totalTokens === 0
  const activity = activityState.data
  const rangeData = rangeState.data
  const refreshing = summaryState.loading || activityState.loading || rangeState.loading

  // One shared cut per range: the trend's stacked layers and the donut/ranking
  // consume the same order, so colors can never disagree between the two.
  const trendCut = useMemo(
    () => (rangeData === undefined ? null : cutNamed(modelTotalsOf(rangeData.daily.days), 5)),
    [rangeData],
  )
  const donutCut = useMemo(
    () => (rangeData === undefined ? null : breakdownCut(rangeData.breakdown, 5)),
    [rangeData],
  )

  const refreshButton = (
    <Tooltip label={t('action.refresh')}>
      <Button
        variant="toolbar"
        size="sm"
        disabled={refreshing}
        aria-label={t('action.refresh')}
        onClick={() => { void loadAll({ announce: true }) }}
      >
        <IconRefreshOutline16 className={refreshing ? styles.spin : undefined} />
      </Button>
    </Tooltip>
  )

  const pillGroup = (options: Array<{ id: string, label: string }>, active: string, onSelect: (id: string) => void): ReactNode => (
    <span className={styles.pillGroup} role="group">
      {options.map(option => (
        <Pill
          key={option.id}
          active={option.id === active}
          aria-pressed={option.id === active}
          onClick={() => { onSelect(option.id) }}
        >
          {option.label}
        </Pill>
      ))}
    </span>
  )

  const sectionError = (message: string | undefined, retry: () => void): ReactNode => (
    <p className={styles.blockErrorRow}>
      <span className={styles.blockError}>{t('state.error', { message: message ?? '' })}</span>
      <Pill onClick={retry}>{t('action.retry')}</Pill>
    </p>
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
      {announce !== '' && <p className={styles.announce} role="status">{announce}</p>}

      {summary === undefined && summaryState.error === undefined && <p className={styles.state}>{t('state.loading')}</p>}
      {summaryState.error !== undefined && sectionError(summaryState.error, () => { void loadSummary() })}

      {summary !== undefined && (
        <>
          <p className={styles.meta}>
            {t('meta.line', {
              time: formatRelative(summary.generatedAt, language),
              date: summary.firstDate === null ? '—' : formatDateWithImplicitYear(summary.firstDate, language),
              days: summary.activeDays,
            })}
          </p>

          <div className={styles.summaryBand}>
            <div className={styles.summaryCell}>
              <span className={styles.summaryLabel}>{t('summary.totalTokens')}</span>
              <span className={styles.summaryValue}>{formatTokens(summary.totalTokens, language)}</span>
            </div>
            <div className={styles.summaryCell}>
              <span className={styles.summaryLabel}>{t('summary.cacheHit')}</span>
              <span className={styles.summaryValue}>{formatPercent(summary.cacheHitRate)}</span>
              <span className={styles.summaryHint}>{t('summary.cacheHit.hint')}</span>
            </div>
            <div className={styles.summaryCell}>
              <span className={styles.summaryLabel}>{t('summary.speed')}</span>
              <span className={styles.summaryValue}>{formatSpeed(summary.speedTokensPerSec)}</span>
              <span className={styles.summaryHint}>{t('summary.speed.hint')}</span>
            </div>
            <div className={styles.summaryCell}>
              <span className={styles.summaryLabel}>{t('summary.call')}</span>
              <span className={styles.summaryValue}>{formatDuration(summary.avgCallMs, language)}</span>
            </div>
          </div>

          {empty && <p className={styles.state}>{t('state.empty')}</p>}

          {!empty && (
            <>
              <div className={styles.block}>
                <div className={styles.blockHead}>
                  <h3 className={styles.blockTitle}>{t('heatmap.title')}</h3>
                  {pillGroup([
                    { id: 'daily', label: t('heatmap.mode.daily') },
                    { id: 'weekly', label: t('heatmap.mode.weekly') },
                  ], activityMode, mode => { setActivityMode(mode as ActivityMode) })}
                </div>
                {activityState.error !== undefined
                  ? sectionError(activityState.error, () => { void loadActivity() })
                  : activity === undefined
                    ? <p className={styles.blockState}>{t('state.loading')}</p>
                    : <ActivityHeatmap activity={activity} lang={language} t={t} />}
              </div>

              <div className={styles.block}>
                <div className={styles.blockHead}>
                  <h3 className={styles.blockTitle}>{t('range.title')}</h3>
                  <span className={styles.rangeControls}>
                    {pillGroup([
                      { id: '7', label: t('range.7') },
                      { id: '30', label: t('range.30') },
                      { id: 'custom', label: t('range.custom') },
                    ], range, value => { setRange(value as RangeTab) })}
                    {range === 'custom' && (
                      <span className={styles.rangeDates}>
                        <input
                          type="date"
                          className={styles.dateInput}
                          value={from}
                          aria-label={t('range.from')}
                          onChange={e => { setFrom(e.target.value) }}
                        />
                        <span aria-hidden>→</span>
                        <input
                          type="date"
                          className={styles.dateInput}
                          value={to}
                          aria-label={t('range.to')}
                          onChange={e => { setTo(e.target.value) }}
                        />
                      </span>
                    )}
                  </span>
                </div>
                {rangeIssue !== null && (
                  <p className={styles.rangeError} role="alert">
                    {t(rangeIssue.key, 'days' in rangeIssue ? { days: rangeIssue.days } : undefined)}
                  </p>
                )}
              </div>

              <div className={styles.block}>
                <div className={styles.blockHead}>
                  <h3 className={styles.blockTitle}>{t('trend.title')}</h3>
                </div>
                {rangeState.error !== undefined
                  ? sectionError(rangeState.error, () => { void loadRange() })
                  : rangeData === undefined
                    ? rangeIssue !== null
                      ? null
                      : <p className={styles.blockState}>{t('state.loading')}</p>
                    : trendCut === null || rangeData.daily.days.length === 0
                      ? <p className={styles.blockState}>{t('trend.empty')}</p>
                      : <TrendChart days={rangeData.daily.days} cut={trendCut} lang={language} t={t} />}
                {trendCut !== null && rangeData !== undefined && rangeData.daily.days.length > 0 && (
                  <LegendRow cut={trendCut} t={t} />
                )}
              </div>

              <div className={styles.block}>
                <div className={styles.blockHead}>
                  <h3 className={styles.blockTitle}>{t('donut.title')}</h3>
                </div>
                {rangeState.error !== undefined
                  ? null
                  : rangeData === undefined
                    ? rangeIssue !== null
                      ? null
                      : <p className={styles.blockState}>{t('state.loading')}</p>
                    : donutCut === null || donutCut.all.length === 0
                      ? <p className={styles.blockState}>{t('donut.empty')}</p>
                      : <DonutChart cut={donutCut} shares={donutCut.shares} lang={language} t={t} />}
              </div>
            </>
          )}
        </>
      )}
    </section>
  )
}

/** Error message extraction shared by every group. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export default UsageStatsSection
