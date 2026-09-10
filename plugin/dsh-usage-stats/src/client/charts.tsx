/**
 * Hand-written SVG charts for the usage-stats page: the GitHub-style activity
 * heatmap, the per-day STACKED BAR trend (one bar per day, models layered by
 * color, bar height = that day's total), and the model-usage donut with its
 * ranking. No chart library — the client bundle purity gate forbids third
 * party deps. Every className goes through the CSS Module map (the redesign's
 * P0 fix: raw `usage*` strings never matched the hashed selectors), every
 * product word arrives through the `t`/`lang` props, and all series order /
 * totals come from ./chart-data.ts so the stacked layers, tooltips, arcs, and
 * the ranking list cannot disagree.
 *
 * @module dsh-usage-stats/client/charts
 */

import * as React from 'react'
import type { ReactNode } from 'react'
import type { UsageStatsActivity, UsageStatsActivityCell, UsageStatsQuality } from '../types.ts'
import type { NamedCut } from './chart-data.ts'
import { OTHER_KEY, gutterOf, niceCeil, stackedPoints } from './chart-data.ts'
import type { UsageStatsLang } from './format.ts'
import { formatDateFull, formatDateShort, formatPercent, formatSpeed, formatTokens, formatTokensAxis } from './format.ts'
import type { Translate } from './UsageStatsSection.tsx'
import styles from './UsageStatsSection.module.css'

/** Series color: component-level palette vars declared on `.section`. */
export function seriesColor(index: number): string {
  return `var(--us-s${Math.min(index, 4) + 1})`
}

/** Color of the aggregated “other” bucket. */
export const OTHER_COLOR = 'var(--us-so)'

/** Heatmap bucket fills: level 0 (empty) .. 4 (max). */
const HEAT_FILLS = [
  'var(--us-heat-0)',
  'var(--us-heat-1)',
  'var(--us-heat-2)',
  'var(--us-heat-3)',
  'var(--us-heat-4)',
] as const

/** Clamp `value` into [min, max]. */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** Localized short label of a series entry (“其他” / “Other” for the bucket). */
function labelOf(key: string, label: string, t: Translate): string {
  return key === OTHER_KEY ? t('series.other') : label
}

// ── Shared hover data card ────────────────────────────────────────────────

interface TipCardProps {
  x: number
  y: number
  /** Estimated card size for viewport clamping. */
  width?: number
  height?: number
  children: ReactNode
}

/**
 * Viewport-clamped fixed data card. `position: fixed` keeps it out of the
 * settings modal's scroll containers; the clamp keeps it inside the viewport
 * (the redesign's “tooltip cannot be clipped or overflow” rule).
 */
function TipCard({ x, y, width = 190, height = 72, children }: TipCardProps): ReactNode {
  const vw = typeof window === 'undefined' ? 1024 : window.innerWidth
  const vh = typeof window === 'undefined' ? 768 : window.innerHeight
  const left = clamp(x + 14, 8, Math.max(8, vw - width - 8))
  const top = clamp(y + 16, 8, Math.max(8, vh - height - 8))
  return (
    <div className={styles.tipCard} style={{ left, top }} role="tooltip">
      {children}
    </div>
  )
}

// ── Activity heatmap ──────────────────────────────────────────────────────

interface HeatmapProps {
  activity: UsageStatsActivity
  lang: UsageStatsLang
  t: Translate
}

interface HeatFocus {
  cell: UsageStatsActivityCell
  x: number
  y: number
}

/**
 * GitHub-style activity grid: 7 weekday rows × ~52 week columns (weekly mode:
 * one row of week cells). Its fixed viewBox preserves the 8px cell rhythm,
 * while CSS scales the complete year to the available card width.
 * Interaction: hover (pointer), click/touch (toggle pin), and a
 * roving-tabindex keyboard cursor (arrows / Home / End) over the cells.
 */
export function ActivityHeatmap({ activity, lang, t }: HeatmapProps): ReactNode {
  const [hover, setHover] = React.useState<HeatFocus | null>(null)
  const [pinned, setPinned] = React.useState<HeatFocus | null>(null)
  const [cursor, setCursor] = React.useState(0)
  const weekly = activity.mode === 'weekly'
  const cells = activity.cells
  const cell = 8
  const gap = 2
  const step = cell + gap
  const left = 26
  const top = 16
  const columns = weekly ? cells.length : Math.ceil(cells.length / 7)
  const rows = weekly ? 1 : 7
  const width = left + columns * step
  const height = top + rows * step
  const shown = pinned ?? hover

  const weekdayLabels: Array<{ row: number, key: 'heatmap.wd.mon' | 'heatmap.wd.wed' | 'heatmap.wd.fri' }> = weekly
    ? []
    : [
        { row: 0, key: 'heatmap.wd.mon' },
        { row: 2, key: 'heatmap.wd.wed' },
        { row: 4, key: 'heatmap.wd.fri' },
      ]

  const monthMarks: Array<{ x: number, label: string }> = []
  let lastMonth = -1
  for (let column = 0; column < columns; column += 1) {
    const anchor = weekly ? cells[column] : cells[column * 7]
    if (anchor === undefined) continue
    const month = Number(anchor.date.slice(5, 7))
    if (month !== lastMonth) {
      monthMarks.push({ x: left + column * step, label: String(month) })
      lastMonth = month
    }
  }

  const locate = (event: { clientX: number, clientY: number, currentTarget: Element }): UsageStatsActivityCell | undefined => {
    const rect = event.currentTarget.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return undefined
    const x = (event.clientX - rect.left) * (width / rect.width)
    const y = (event.clientY - rect.top) * (height / rect.height)
    const column = Math.floor((x - left) / step)
    const row = weekly ? 0 : Math.floor((y - top) / step)
    const index = weekly ? column : column * 7 + row
    return column >= 0 && column < columns && row >= 0 && row < rows ? cells[index] : undefined
  }

  const focusCell = (entry: UsageStatsActivityCell, point: { clientX: number, clientY: number }): void => {
    setHover({ cell: entry, x: point.clientX, y: point.clientY })
    const index = cells.indexOf(entry)
    if (index >= 0) setCursor(index)
  }

  const onKeyDown = (event: React.KeyboardEvent<SVGSVGElement>): void => {
    const current = clamp(cursor, 0, cells.length - 1)
    let next: number | null = null
    if (weekly) {
      if (event.key === 'Home') next = 0
      else if (event.key === 'End') next = cells.length - 1
      else if (event.key === 'ArrowLeft') next = Math.max(0, current - 1)
      else if (event.key === 'ArrowRight') next = Math.min(cells.length - 1, current + 1)
    } else {
      const column = Math.floor(current / 7)
      const row = current % 7
      if (event.key === 'Home') next = 0
      else if (event.key === 'End') next = cells.length - 1
      else if (event.key === 'ArrowLeft') next = Math.max(column - 1, 0) * 7 + row
      else if (event.key === 'ArrowRight') next = Math.min(column + 1, columns - 1) * 7 + row
      else if (event.key === 'ArrowUp') next = column * 7 + clamp(row - 1, 0, 6)
      else if (event.key === 'ArrowDown') next = column * 7 + clamp(row + 1, 0, 6)
    }
    if (next === null) return
    event.preventDefault()
    setCursor(next)
    const entry = cells[next]
    if (entry !== undefined) {
      const rect = event.currentTarget.getBoundingClientRect()
      const column = weekly ? next : Math.floor(next / 7)
      const row = weekly ? 0 : next % 7
      const scaleX = rect.width / width
      const scaleY = rect.height / height
      setHover({
        cell: entry,
        x: rect.left + (left + column * step + step / 2) * scaleX,
        y: rect.top + (top + row * step) * scaleY,
      })
    }
  }

  const kids: ReactNode[] = monthMarks.map(mark => (
    <text key={`m${mark.x}`} x={mark.x} y={10} className={styles.heatAxis}>
      {mark.label}
    </text>
  ))
  weekdayLabels.forEach(({ row, key }) => {
    kids.push(
      <text
        key={`w${row}`}
        x={left - 4}
        y={top + row * step + cell - 1}
        textAnchor="end"
        className={styles.heatAxis}
      >
        {t(key)}
      </text>,
    )
  })
  cells.forEach((entry, index) => {
    const column = weekly ? index : Math.floor(index / 7)
    const row = weekly ? 0 : index - column * 7
    kids.push(
      <rect
        key={`${entry.date}:${index}`}
        x={left + column * step}
        y={top + row * step}
        width={cell}
        height={cell}
        rx={1.5}
        fill={HEAT_FILLS[clamp(entry.level, 0, 4)]}
        className={styles.heatCell}
        tabIndex={index === cursor ? 0 : -1}
        role="button"
        aria-label={`${formatDateFull(entry.date, lang)} · ${formatTokens(entry.total, lang)}`}
        onFocus={(event) => {
          const rect = event.currentTarget.getBoundingClientRect()
          focusCell(entry, { clientX: rect.left + rect.width / 2, clientY: rect.top })
        }}
        onBlur={() => { setHover(null) }}
        onPointerEnter={(event) => { focusCell(entry, event) }}
        onPointerLeave={() => { setHover(null) }}
        onClick={(event) => {
          if (pinned !== null && pinned.cell === entry) setPinned(null)
          else setPinned({ cell: entry, x: event.clientX, y: event.clientY })
        }}
      />,
    )
  })

  const tip = shown === null ? null : (
    <TipCard x={shown.x} y={shown.y} width={210} height={64}>
      <div className={styles.tipTitle}>
        {t(weekly ? 'heatmap.cell.week' : 'heatmap.cell.day', { date: formatDateFull(shown.cell.date, lang) })}
      </div>
      <div className={styles.tipRow}>
        <span
          className={styles.swatch}
          style={{ background: HEAT_FILLS[clamp(shown.cell.level, 0, 4)] }}
        />
        {t('heatmap.cell.detail', { tokens: formatTokens(shown.cell.total, lang), calls: shown.cell.calls })}
      </div>
    </TipCard>
  )

  return (
    <div className={styles.heatWrap} data-usage-heatmap="chart">
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        className={styles.chartSvg}
        role="img"
        aria-label={t('heatmap.title')}
        onKeyDown={onKeyDown}
        onPointerMove={(event) => {
          const entry = locate(event)
          if (entry === undefined) setHover(null)
          else focusCell(entry, event)
        }}
        onPointerLeave={() => { setHover(null) }}
      >
        <title>{t('heatmap.title')}</title>
        <desc>{t('heatmap.desc')}</desc>
        {kids}
      </svg>
      {tip}
      <div className={styles.heatLegendRow}>
        <span className={styles.heatLegendText}>{t('heatmap.legend.less')}</span>
        {HEAT_FILLS.map(fill => (
          <span key={fill} className={styles.swatch} style={{ background: fill, width: 10, height: 10 }} />
        ))}
        <span className={styles.heatLegendText}>{t('heatmap.legend.more')}</span>
      </div>
    </div>
  )
}

// ── Multi-series daily trend ─────────────────────────────────────────────

interface TrendProps {
  days: ReadonlyArray<{ date: string, total: number, byModel: ReadonlyArray<{ model: string, tokens: number }> }>
  cut: NamedCut
  lang: UsageStatsLang
  t: Translate
}

interface TrendHover {
  index: number
  x: number
  y: number
}

/** Viewbox width: the plot scales responsively to the section width. */
const TREND_WIDTH = 560
const TREND_HEIGHT = 190

/**
 * Per-model daily lines. The shared cut keeps line, legend, and donut colors
 * stable while the curve matches the established usage dashboard treatment.
 */
export function TrendChart({ days, cut, lang, t }: TrendProps): ReactNode {
  const [hover, setHover] = React.useState<TrendHover | null>(null)
  const points = React.useMemo(() => stackedPoints(days, cut), [days, cut])
  const axisMax = React.useMemo(
    () => niceCeil(points.reduce((max, point) => Math.max(max, ...point.values), 0)),
    [points],
  )
  const ticks = React.useMemo(
    () => [1, 0.75, 0.5, 0.25, 0].map(ratio => formatTokensAxis(axisMax * ratio, lang)),
    [axisMax, lang],
  )
  const left = React.useMemo(() => gutterOf(ticks), [ticks])
  const right = 8
  const top = 8
  const bottom = 22
  const plotWidth = TREND_WIDTH - left - right
  const plotHeight = TREND_HEIGHT - top - bottom

  if (points.length === 0) return <p className={styles.blockState}>{t('trend.empty')}</p>

  const slot = points.length > 1 ? plotWidth / (points.length - 1) : plotWidth
  const xOf = (index: number): number => points.length === 1 ? left + plotWidth / 2 : left + slot * index
  const yOf = (value: number): number => top + plotHeight - (value / axisMax) * plotHeight

  const dateLabel = (index: number): string => formatDateShort(points[index]!.date, lang)
  const tickIndexes = points.length <= 7
    ? points.map((_, index) => index)
    : [0, Math.floor((points.length - 1) / 2), points.length - 1]

  const kids: ReactNode[] = ticks.map((tick, index) => (
    <g key={`g${index}`}>
      <line
        x1={left}
        x2={TREND_WIDTH - right}
        y1={top + (index / (ticks.length - 1)) * plotHeight}
        y2={top + (index / (ticks.length - 1)) * plotHeight}
        className={styles.gridLine}
      />
      <text
        x={left - 6}
        y={top + (index / (ticks.length - 1)) * plotHeight + 3.5}
        textAnchor="end"
        className={styles.axisText}
      >
        {tick}
      </text>
    </g>
  ))
  tickIndexes.forEach(index => {
    kids.push(
      <text key={`t${index}`} x={xOf(index)} y={TREND_HEIGHT - 6} textAnchor="middle" className={styles.axisText}>
        {dateLabel(index)}
      </text>,
    )
  })
  cut.all.forEach((entry, series) => {
    const line = points.map((point, index): [number, number] => [xOf(index), yOf(point.values[series] ?? 0)])
    kids.push(
      <path
        key={entry.key}
        d={smoothPath(line)}
        stroke={entry.key === OTHER_KEY ? OTHER_COLOR : seriesColor(series)}
        className={styles.trendLine}
        data-trend-line="series"
      />,
    )
  })

  const hoverPoint = hover === null ? undefined : points[hover.index]
  if (hover !== null && hoverPoint !== undefined) {
    kids.push(
      <line
        key="hoverline"
        x1={xOf(hover.index)}
        x2={xOf(hover.index)}
        y1={top}
        y2={top + plotHeight}
        className={styles.gridLine}
      />,
    )
  }

  const tip = hover === null || hoverPoint === undefined ? null : (
    <TipCard x={hover.x} y={hover.y} width={220} height={40 + cut.all.length * 18}>
      <div className={styles.tipTitle}>
        {formatDateFull(hoverPoint.date, lang)} · {formatTokens(hoverPoint.total, lang)}
      </div>
      {hoverPoint.total <= 0
        ? <div className={styles.tipRow}>{t('trend.empty')}</div>
        : cut.all.map((entry, series) => {
            const value = hoverPoint.values[series] ?? 0
            if (value <= 0) return null
            return (
              <div key={entry.key} className={styles.tipRow}>
                <span className={styles.swatch} style={{ background: entry.key === OTHER_KEY ? OTHER_COLOR : seriesColor(series) }} />
                {labelOf(entry.key, entry.label, t)}
                <span className={styles.tipValue}>{formatTokens(value, lang)}</span>
              </div>
            )
          })}
    </TipCard>
  )

  return (
    <div
      className={styles.trendWrap}
      onPointerMove={(event) => {
        const svg = event.currentTarget.firstElementChild as SVGSVGElement | null
        if (svg === null) return
        const rect = svg.getBoundingClientRect()
        const scale = rect.width / TREND_WIDTH
        const x = (event.clientX - rect.left) / scale
        const index = Math.round((x - left) / slot)
        if (index < 0 || index >= points.length) {
          setHover(null)
          return
        }
        setHover({ index, x: event.clientX, y: event.clientY })
      }}
      onPointerLeave={() => { setHover(null) }}
    >
      <svg
        viewBox={`0 0 ${TREND_WIDTH} ${TREND_HEIGHT}`}
        className={styles.chartSvg}
        role="img"
        aria-label={t('trend.title')}
      >
        <title>{t('trend.title')}</title>
        <desc>{t('trend.desc')}</desc>
        {kids}
      </svg>
      {tip}
    </div>
  )
}

/** Catmull-Rom spline emitted as cubic Bezier segments. */
function smoothPath(points: Array<[number, number]>): string {
  if (points.length === 0) return ''
  if (points.length === 1) return `M ${points[0]![0]} ${points[0]![1]}`
  const tension = 0.16
  let path = `M ${points[0]![0]} ${points[0]![1]}`
  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = points[i - 1] ?? points[i]!
    const p1 = points[i]!
    const p2 = points[i + 1]!
    const p3 = points[i + 2] ?? p2
    path += ` C ${p1[0] + (p2[0] - p0[0]) * tension} ${p1[1] + (p2[1] - p0[1]) * tension}, ${p2[0] - (p3[0] - p1[0]) * tension} ${p2[1] - (p3[1] - p1[1]) * tension}, ${p2[0]} ${p2[1]}`
  }
  return path
}

// ── Model quality grouped bars ───────────────────────────────────────────

const QUALITY_WIDTH = 560
const QUALITY_HEIGHT = 220
const HIT_FILL = 'var(--us-s2)'
const SPEED_FILL = 'var(--us-s3)'

/** Cache-hit and output-rate grouped bars, matching the established board. */
export function QualityBars({ quality, t }: { quality: UsageStatsQuality, t: Translate }): ReactNode {
  const [hover, setHover] = React.useState<{ index: number, x: number, y: number } | null>(null)
  const models = quality.models.slice(0, 8)
  const left = 38
  const right = 38
  const top = 12
  const bottom = 40
  const plotWidth = QUALITY_WIDTH - left - right
  const plotHeight = QUALITY_HEIGHT - top - bottom
  const groupWidth = models.length > 0 ? plotWidth / models.length : plotWidth
  const barWidth = Math.min(22, groupWidth * 0.3)
  const maxSpeed = niceCeil(models.reduce((max, model) => Math.max(max, model.speedTokensPerSec ?? 0), 1))
  const kids: ReactNode[] = []

  for (const ratio of [0, 0.25, 0.5, 0.75, 1]) {
    const y = top + ratio * plotHeight
    kids.push(
      <line key={`g${ratio}`} x1={left} x2={QUALITY_WIDTH - right} y1={y} y2={y} className={styles.gridLine} />,
      <text key={`l${ratio}`} x={left - 6} y={y + 3.5} textAnchor="end" className={styles.axisText}>{Math.round((1 - ratio) * 100)}%</text>,
      <text key={`r${ratio}`} x={QUALITY_WIDTH - right + 6} y={y + 3.5} className={styles.axisText}>{Math.round(maxSpeed * (1 - ratio))}</text>,
    )
  }

  models.forEach((model, index) => {
    const center = left + groupWidth * index + groupWidth / 2
    const hitHeight = (model.hitRate ?? 0) * plotHeight
    const speedHeight = ((model.speedTokensPerSec ?? 0) / maxSpeed) * plotHeight
    const bare = model.model.slice(model.model.indexOf('/') + 1)
    const short = bare.length > 10 ? `${bare.slice(0, 8)}…` : bare
    kids.push(
      <rect key={`h${model.model}`} x={center - barWidth - 2} y={top + plotHeight - hitHeight} width={barWidth} height={hitHeight} rx={2} fill={HIT_FILL} data-quality-bar="cache" />,
      <rect key={`s${model.model}`} x={center + 2} y={top + plotHeight - speedHeight} width={barWidth} height={speedHeight} rx={2} fill={SPEED_FILL} data-quality-bar="speed" />,
      <text key={`x${model.model}`} x={center} y={QUALITY_HEIGHT - 10} textAnchor="middle" className={styles.axisText}>{short}</text>,
      <rect
        key={`hit${model.model}`}
        x={left + groupWidth * index}
        y={top}
        width={groupWidth}
        height={plotHeight}
        className={styles.trendHit}
        tabIndex={0}
        role="button"
        aria-label={`${bare} · ${t('quality.cacheHit')} ${formatPercent(model.hitRate)} · ${t('quality.speed')} ${formatSpeed(model.speedTokensPerSec)}`}
        onFocus={event => {
          const rect = event.currentTarget.getBoundingClientRect()
          setHover({ index, x: rect.left + rect.width / 2, y: rect.top })
        }}
        onBlur={() => { setHover(null) }}
        onPointerEnter={event => { setHover({ index, x: event.clientX, y: event.clientY }) }}
        onPointerMove={event => { setHover({ index, x: event.clientX, y: event.clientY }) }}
        onPointerLeave={() => { setHover(null) }}
      />,
    )
  })

  const active = hover === null ? undefined : models[hover.index]
  return (
    <div className={styles.qualityWrap}>
      <svg viewBox={`0 0 ${QUALITY_WIDTH} ${QUALITY_HEIGHT}`} className={styles.chartSvg} role="img" aria-label={t('quality.title')}>
        <title>{t('quality.title')}</title>
        <desc>{t('quality.desc')}</desc>
        {kids}
      </svg>
      {hover !== null && active !== undefined && (
        <TipCard x={hover.x} y={hover.y} width={210} height={76}>
          <div className={styles.tipTitle}>{active.model}</div>
          <div className={styles.tipRow}><span className={styles.swatch} style={{ background: HIT_FILL }} />{t('quality.cacheHit')}<span className={styles.tipValue}>{formatPercent(active.hitRate)}</span></div>
          <div className={styles.tipRow}><span className={styles.swatch} style={{ background: SPEED_FILL }} />{t('quality.speed')}<span className={styles.tipValue}>{formatSpeed(active.speedTokensPerSec)}</span></div>
        </TipCard>
      )}
      <ul className={styles.legendRow}>
        <li className={styles.legendItem}><span className={styles.swatch} style={{ background: HIT_FILL }} />{t('quality.cacheHit')}</li>
        <li className={styles.legendItem}><span className={styles.swatch} style={{ background: SPEED_FILL }} />{t('quality.speedLegend')}</li>
      </ul>
    </div>
  )
}

// ── Model usage donut + ranking ───────────────────────────────────────────

interface DonutProps {
  cut: NamedCut
  shares: ReadonlyArray<number>
  lang: UsageStatsLang
  t: Translate
}

/** Donut geometry: 128px ring, 14px track, 2° gaps between arcs. */
const DONUT_SIZE = 128
const DONUT_GAP_DEG = 2

/**
 * Share donut with a semantic ranking list. Arcs and rows are the same data
 * (the shared {@link NamedCut} plus renormalized shares), so the ring always
 * sums to 100% and hover/focus on either side highlights the same entry.
 */
export function DonutChart({ cut, shares, lang, t }: DonutProps): ReactNode {
  const [focus, setFocus] = React.useState<number | null>(null)
  const size = DONUT_SIZE
  const center = size / 2
  const radius = 52
  const trackWidth = 14
  const total = cut.all.reduce((sum, entry) => sum + entry.tokens, 0)
  const circumference = 2 * Math.PI * radius
  const gapPer = (DONUT_GAP_DEG / 360) * circumference

  const arcs = cut.all.map((entry, index) => {
    const share = shares[index] ?? 0
    const dash = Math.max(0, share * circumference - gapPer)
    let offset = 0
    for (let before = 0; before < index; before += 1) offset += (shares[before] ?? 0) * circumference
    const dimmed = focus !== null && focus !== index
    return (
      <circle
        key={entry.key}
        cx={center}
        cy={center}
        r={radius}
        fill="none"
        stroke={entry.key === OTHER_KEY ? OTHER_COLOR : seriesColor(index)}
        strokeWidth={trackWidth}
        strokeDasharray={`${dash} ${circumference - dash}`}
        strokeDashoffset={-offset}
        strokeLinecap="butt"
        transform={`rotate(-90 ${center} ${center})`}
        className={dimmed ? `${styles.donutArc} ${styles.donutDim}` : styles.donutArc}
        data-donut-arc="slice"
        tabIndex={0}
        role="button"
        aria-label={`${labelOf(entry.key, entry.label, t)} · ${formatTokens(entry.tokens, lang)}`}
        onFocus={() => { setFocus(index) }}
        onBlur={() => { setFocus(null) }}
        onPointerEnter={() => { setFocus(index) }}
        onPointerLeave={() => { setFocus(null) }}
      />
    )
  })

  return (
    <div className={styles.donutRow}>
      <div className={styles.donutWrap}>
        <svg viewBox={`0 0 ${size} ${size}`} className={styles.chartSvg} role="img" aria-label={t('donut.title')}>
          <title>{t('donut.title')}</title>
          <desc>{t('donut.desc')}</desc>
          {total <= 0 && (
            <circle
              cx={center}
              cy={center}
              r={radius}
              fill="none"
              stroke="var(--us-heat-0)"
              strokeWidth={trackWidth}
            />
          )}
          {arcs}
        </svg>
        <span className={styles.donutCenter}>
          <span className={styles.donutCenterValue}>{formatTokens(total, lang)}</span>
          <span className={styles.donutCenterLabel}>{t('donut.total')}</span>
        </span>
      </div>
      <ul className={styles.donutList}>
        {cut.all.map((entry, index) => {
          const share = shares[index] ?? 0
          const dimmed = focus !== null && focus !== index
          return (
            <li
              key={entry.key}
              className={dimmed ? `${styles.donutItem} ${styles.donutDim}` : styles.donutItem}
              onPointerEnter={() => { setFocus(index) }}
              onPointerLeave={() => { setFocus(null) }}
            >
              <span
                className={styles.swatch}
                style={{ background: entry.key === OTHER_KEY ? OTHER_COLOR : seriesColor(index) }}
              />
              <span className={styles.donutLabel} title={entry.key === OTHER_KEY ? undefined : entry.key}>
                {labelOf(entry.key, entry.label, t)}
              </span>
              <span className={styles.donutValue}>
                {`${formatTokens(entry.tokens, lang)} · ${Math.round(share * 1000) / 10}%`}
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

// ── Shared legend row ─────────────────────────────────────────────────────

/** Legend entries for a cut: swatch + label, “other” localized. */
export function LegendRow({ cut, t }: { cut: NamedCut, t: Translate }): ReactNode {
  return (
    <ul className={styles.legendRow}>
      {cut.all.map((entry, index) => (
        <li key={entry.key} className={styles.legendItem}>
          <span className={styles.swatch} style={{ background: entry.key === OTHER_KEY ? OTHER_COLOR : seriesColor(index) }} />
          {labelOf(entry.key, entry.label, t)}
        </li>
      ))}
    </ul>
  )
}
