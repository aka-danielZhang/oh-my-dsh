/**
 * Hand-written SVG charts for the usage-stats page: a GitHub-style activity
 * heatmap, a multi-series daily trend, and a share donut. No chart library —
 * the client bundle purity gate forbids third-party deps; each chart is a
 * hundred-line component over plain coordinates. Colors resolve exclusively
 * through `--dsw-*` tokens; every chart carries a hover data card (absolute
 * inside its plot for the trend/donut, `position: fixed` for the heatmap so
 * the scroll container cannot clip it).
 *
 * @module dsh-usage-stats/client/charts
 */

import * as React from 'react'
import type { ReactNode } from 'react'
import type { UsageStatsActivity, UsageStatsActivityCell, UsageStatsBreakdown, UsageStatsDaily, UsageStatsQuality } from '../types.ts'
import type { Translate } from './format.ts'

/** Series palette (model/provider lines and donut slices), all token-based. */
const SERIES_COLORS = [
  'var(--dsw-static-deepseek-500)',
  'var(--dsw-static-blue-500)',
  'var(--dsw-static-green-500)',
  'var(--dsw-static-amber-500)',
  'var(--dsw-static-red-400)',
  'var(--dsw-static-blue-300)',
  'var(--dsw-static-deepseek-300)',
] as const

/** Heatmap buckets: level 0 (empty) .. 4 (max). */
const HEAT_FILLS = [
  'var(--dsw-alias-bg-module-platform)',
  'var(--dsw-static-blue-100)',
  'var(--dsw-static-blue-300)',
  'var(--dsw-static-blue-450)',
  'var(--dsw-static-blue-600)',
] as const

export function seriesColor(index: number): string {
  return SERIES_COLORS[index % SERIES_COLORS.length]!
}

/** day index (days since epoch UTC) of a `yyyy-mm-dd` key. */
function dayIndexOf(dateKey: string): number {
  return Math.floor(Date.parse(`${dateKey}T00:00:00.000Z`) / 86_400_000)
}

/** Monday-based weekday (0..6) of a `yyyy-mm-dd` key. */
function weekdayOf(dateKey: string): number {
  return (dayIndexOf(dateKey) + 3) % 7
}

/** Short month label derived from the key, locale-agnostic digits. */
function monthOf(dateKey: string): number {
  return Number(dateKey.slice(5, 7))
}

/** “9月6日” from a `yyyy-mm-dd` key. */
function cnDate(dateKey: string): string {
  const parts = dateKey.split('-')
  return Number(parts[1]) + '月' + Number(parts[2]) + '日'
}

/** “2026年9月6日” from a `yyyy-mm-dd` key. */
function cnDateFull(dateKey: string): string {
  const parts = dateKey.split('-')
  return parts[0] + '年' + Number(parts[1]) + '月' + Number(parts[2]) + '日'
}

interface HeatmapProps {
  activity: UsageStatsActivity
  t: Translate
  format: (value: number) => string
}

interface HeatHover {
  cell: UsageStatsActivityCell
  /** Viewport coordinates — the card is position:fixed. */
  x: number
  y: number
  flip: boolean
}

/** GitHub-style activity grid: 7 weekday rows × ~52 week columns (weekly mode: one row). */
export function ActivityHeatmap({ activity, t, format }: HeatmapProps): ReactNode {
  const [hover, setHover] = React.useState<HeatHover | null>(null)
  const weekly = activity.mode === 'weekly'
  const cells = activity.cells
  const cell = 10
  const gap = 2
  const step = cell + gap
  const left = 20
  const top = 16
  const columns = weekly ? cells.length : Math.ceil(cells.length / 7)
  const rows = weekly ? 1 : 7
  const width = left + columns * step
  const height = top + rows * step
  const weekdayLabels = ['', '一', '二', '三', '四', '五', '']
  const monthMarks: Array<{ x: number, label: string }> = []
  let lastMonth = -1
  for (let column = 0; column < columns; column += 1) {
    const anchor = weekly ? cells[column] : cells[column * 7]
    if (anchor === undefined) continue
    const month = monthOf(anchor.date)
    if (month !== lastMonth) {
      monthMarks.push({ x: left + column * step, label: String(month) })
      lastMonth = month
    }
  }
  const kids: ReactNode[] = monthMarks.map(mark => (
    <text key={`m${mark.x}`} x={mark.x} y={10} className="usageHeatAxis">
      {mark.label}
    </text>
  ))
  if (!weekly) {
    weekdayLabels.forEach((label, index) => {
      if (label === '') return
      kids.push(
        <text
          key={`w${index}`}
          x={left - 4}
          y={top + index * step + cell - 1}
          textAnchor="end"
          className="usageHeatAxis"
        >
          {label}
        </text>,
      )
    })
  }
  cells.forEach((entry, index) => {
    const column = weekly ? index : Math.floor(index / 7)
    const row = weekly ? 0 : weekdayOf(entry.date)
    kids.push(
      <rect
        key={entry.date}
        x={left + column * step}
        y={top + row * step}
        width={cell}
        height={cell}
        rx={2}
        fill={HEAT_FILLS[Math.min(4, Math.max(0, entry.level))]}
      />,
    )
  })
  const tip = hover === null ? null : (
    <div
      className="usageTipCard usageTipFixed"
      style={{ left: (hover.flip ? hover.x - 190 : hover.x + 14), top: hover.y + 16 }}
    >
      <div className="usageTipTitle">
        {t(weekly ? 'heatmap.cell.week' : 'heatmap.cell.day', { date: cnDateFull(hover.cell.date) })}
      </div>
      <div className="usageTipRow">
        <span className="usageTipSwatch" style={{ background: HEAT_FILLS[Math.min(4, Math.max(0, hover.cell.level))] }} />
        {format(hover.cell.total) + ' tokens'}
        <span className="usageTipValue">{hover.cell.calls + ' 轮'}</span>
      </div>
    </div>
  )
  return (
    <div className="usageHeatWrap">
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={t('heatmap.title')}
        onMouseMove={(event) => {
          const rect = event.currentTarget.getBoundingClientRect()
          const x = event.clientX - rect.left
          const y = event.clientY - rect.top
          const column = Math.floor((x - left) / step)
          const row = weekly ? 0 : Math.floor((y - top) / step)
          const index = weekly ? column : column * 7 + row
          const entry = column >= 0 && column < columns && row >= 0 && row < rows ? cells[index] : undefined
          if (entry === undefined) {
            setHover(null)
            return
          }
          setHover({
            cell: entry,
            x: event.clientX,
            y: event.clientY,
            flip: column >= columns - 5,
          })
        }}
        onMouseLeave={() => setHover(null)}
      >
        {kids}
      </svg>
      {tip}
      <span className="usageHeatLegend">
        <span className="usageHeatAxisText">{t('heatmap.legend.less')}</span>
        {HEAT_FILLS.map(fill => (
          <span key={fill} className="usageTipSwatch usageHeatSwatchLg" style={{ background: fill }} />
        ))}
        <span className="usageHeatAxisText">{t('heatmap.legend.more')}</span>
      </span>
    </div>
  )
}

interface TrendProps {
  daily: UsageStatsDaily
  t: Translate
  format: (value: number) => string
  colors: ReadonlyMap<string, string>
}

interface TrendHover {
  index: number
  /** Pixels relative to the plot wrapper. */
  x: number
  y: number
}

/** Catmull-Rom-smoothed multi-series line chart of daily totals per model. */
export function TrendChart({ daily, t, format, colors }: TrendProps): ReactNode {
  const [hover, setHover] = React.useState<TrendHover | null>(null)
  const width = 640
  const height = 190
  const left = 46
  const right = 12
  const topChart = 10
  const bottom = 24
  const plotWidth = width - left - right
  const plotHeight = height - topChart - bottom
  const points = daily.days
  const series = new Map<string, number[]>()
  let maxTotal = 0
  for (const entry of points) {
    if (entry.total > maxTotal) maxTotal = entry.total
    for (const { model, tokens } of entry.byModel) {
      const line = series.get(model) ?? []
      line.push(tokens)
      series.set(model, line)
    }
  }
  // Pad series with zeros for days they did not run.
  for (const [model, line] of series) {
    if (line.length === points.length) continue
    const byDay = new Map(points.map((entry, index) => [index, entry.byModel.find(m => m.model === model)?.tokens ?? 0]))
    series.set(model, points.map((_, index) => byDay.get(index) ?? 0))
  }
  const gridMax = niceCeil(maxTotal)
  const xOf = (index: number): number =>
    points.length <= 1 ? left + plotWidth / 2 : left + (index / (points.length - 1)) * plotWidth
  const yOf = (value: number): number => topChart + plotHeight - (value / gridMax) * plotHeight
  const dateLabel = (index: number): string => {
    const key = points[index]!.date
    return key.slice(5).replace('-', '/')
  }
  const tickIndexes = points.length <= 1
    ? [0]
    : [0, Math.floor((points.length - 1) / 2), points.length - 1]
  const kids: ReactNode[] = [0, 0.25, 0.5, 0.75, 1].map(ratio => (
    <g key={ratio}>
      <line x1={left} x2={width - right} y1={topChart + ratio * plotHeight} y2={topChart + ratio * plotHeight} className="usageTrendGrid" />
      <text x={left - 6} y={topChart + ratio * plotHeight + 3.5} textAnchor="end" className="usageTrendAxis">
        {format(gridMax * (1 - ratio))}
      </text>
    </g>
  ))
  tickIndexes.forEach(index => {
    kids.push(
      <text key={`t${index}`} x={xOf(index)} y={height - 8} textAnchor="middle" className="usageTrendAxis">
        {dateLabel(index)}
      </text>,
    )
  })
  ;[...series.entries()].forEach(([model, line], seriesIndex) => {
    kids.push(
      <path
        key={model}
        className="usageTrendLine"
        stroke={colors.get(model) ?? seriesColor(seriesIndex)}
        d={smoothPath(line.map((value, index) => [xOf(index), yOf(value)]))}
      />,
    )
  })
  const hoverPoint = hover !== null ? points[hover.index] : undefined
  if (hover !== null && hoverPoint !== undefined) {
    kids.push(
      <line key="hoverline" x1={xOf(hover.index)} x2={xOf(hover.index)} y1={topChart} y2={topChart + plotHeight} className="usageTrendGrid" />,
    )
  }
  const tip = hover === null || hoverPoint === undefined ? null : (
    <div className="usageTipCard" style={{ left: Math.min(hover.x + 14, 300), top: Math.max(4, hover.y - 30) }}>
      <div className="usageTipTitle">{cnDate(hoverPoint.date) + ' · ' + format(hoverPoint.total) + ' tokens'}</div>
      {hoverPoint.byModel.length === 0
        ? <div className="usageTipRow">无用量</div>
        : hoverPoint.byModel.map(m => (
          <div key={m.model} className="usageTipRow">
            <span className="usageTipSwatch" style={{ background: colors.get(m.model) ?? seriesColor(0) }} />
            {m.model.slice(m.model.indexOf('/') + 1)}
            <span className="usageTipValue">{format(m.tokens)}</span>
          </div>
        ))}
    </div>
  )
  void t
  return (
    <div
      className="usageTrendWrap"
      onMouseMove={(event) => {
        const svg = event.currentTarget.firstElementChild as SVGSVGElement | null
        if (svg === null) return
        const rect = svg.getBoundingClientRect()
        const scale = rect.width / width
        const x = (event.clientX - rect.left) / scale
        const index = Math.round(((x - left) / plotWidth) * (points.length - 1))
        if (index < 0 || index >= points.length) {
          setHover(null)
          return
        }
        const wrapRect = event.currentTarget.getBoundingClientRect()
        setHover({
          index,
          x: event.clientX - wrapRect.left,
          y: event.clientY - wrapRect.top,
        })
      }}
      onMouseLeave={() => setHover(null)}
    >
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={t('trend.title')}>
        {kids}
      </svg>
      {tip}
    </div>
  )
}

interface DonutProps {
  breakdown: UsageStatsBreakdown
  colors: ReadonlyMap<string, string>
  format: (value: number) => string
}

interface DonutHover {
  key: string
  label: string
  tokens: number
  share: number
}

/** Donut of share slices around a centered total, with a hover data card. */
export function DonutChart({ breakdown, colors, format }: DonutProps): ReactNode {
  const [hover, setHover] = React.useState<DonutHover | null>(null)
  const size = 148
  const center = size / 2
  const radius = 54
  const circumference = 2 * Math.PI * radius
  const top = breakdown.slices.slice(0, SERIES_COLORS.length)
  let offset = 0
  const arcs = top.map((slice, index) => {
    const dash = slice.share * circumference
    const arc = (
      <circle
        key={slice.key}
        cx={center}
        cy={center}
        r={radius}
        fill="none"
        stroke={colors.get(slice.key) ?? seriesColor(index)}
        strokeWidth={16}
        strokeDasharray={`${dash} ${circumference - dash}`}
        strokeDashoffset={-offset}
        transform={`rotate(-90 ${center} ${center})`}
        className="usageDonutSlice"
        onMouseEnter={() => setHover(slice)}
        onMouseLeave={() => setHover(null)}
      />
    )
    offset += dash
    return arc
  })
  return (
    <div className="usageDonutRow">
      <div className="usageDonutWrap">
        <svg viewBox={`0 0 ${size} ${size}`} role="img">
          {arcs}
        </svg>
        <span className="usageDonutTotal">{format(breakdown.total)}</span>
        {hover !== null && (
          <div className="usageTipCard usageDonutTip">
            <div className="usageTipRow">
              <span className="usageTipSwatch" style={{ background: colors.get(hover.key) ?? seriesColor(0) }} />
              {hover.label}
            </div>
            <div className="usageTipRow">
              {format(hover.tokens) + ' tokens'}
              <span className="usageTipValue">{Math.round(hover.share * 1000) / 10 + '%'}</span>
            </div>
          </div>
        )}
      </div>
      <ul className="usageSliceList">
        {breakdown.slices.map(slice => (
          <li key={slice.key} className="usageSliceItem">
            <span className="usageTipSwatch" style={{ background: colors.get(slice.key) ?? seriesColor(0) }} />
            <span className="usageSliceLabel" title={slice.key}>{slice.label}</span>
            <span className="usageSliceValue">
              {Math.round(slice.share * 1000) / 10 + '% · ' + format(slice.tokens)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** Round up to a "nice" axis maximum (1/2/5 × 10^k). */
function niceCeil(value: number): number {
  if (value <= 0) return 1
  const exponent = Math.floor(Math.log10(value))
  const base = 10 ** exponent
  for (const scale of [1, 2, 5, 10]) {
    if (value <= scale * base) return scale * base
  }
  return 10 * base
}

/** Catmull-Rom spline through points, emitted as a cubic-bezier path. */
function smoothPath(points: Array<[number, number]>): string {
  if (points.length === 0) return ''
  if (points.length === 1) return `M ${points[0]![0]} ${points[0]![1]}`
  const tension = 0.2
  let path = `M ${points[0]![0]} ${points[0]![1]}`
  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = points[i - 1] ?? points[i]!
    const p1 = points[i]!
    const p2 = points[i + 1]!
    const p3 = points[i + 2] ?? p2
    const c1x = p1[0] + (p2[0] - p0[0]) * tension
    const c1y = p1[1] + (p2[1] - p0[1]) * tension
    const c2x = p2[0] - (p3[0] - p1[0]) * tension
    const c2y = p2[1] - (p3[1] - p1[1]) * tension
    path += ` C ${c1x} ${c1y}, ${c2x} ${c2y}, ${p2[0]} ${p2[1]}`
  }
  return path
}

interface QualityProps {
  quality: UsageStatsQuality
}

interface QualityHover {
  model: string
  hitRate: number | null
  speedTokensPerSec: number | null
}

const HIT_FILL = 'var(--dsw-static-blue-500)'
const SPEED_FILL = 'var(--dsw-static-green-500)'
const MAX_MODELS_IN_CHART = 8

/**
 * Grouped dual-axis bar chart: per model one cache-hit bar (left axis, %)
 * and one apparent-rate bar (right axis, tok/s), with a hover data card.
 */
export function QualityBars({ quality }: QualityProps): ReactNode {
  const [hover, setHover] = React.useState<QualityHover | null>(null)
  const models = quality.models.slice(0, MAX_MODELS_IN_CHART)
  const width = 640
  const height = 220
  const left = 46
  const right = 46
  const topChart = 14
  const bottom = 40
  const plotWidth = width - left - right
  const plotHeight = height - topChart - bottom
  const groupWidth = models.length > 0 ? plotWidth / models.length : plotWidth
  const barWidth = Math.min(22, groupWidth * 0.28)
  let maxSpeed = 1
  for (const m of models) {
    const s = m.speedTokensPerSec ?? 0
    if (s > maxSpeed) maxSpeed = s
  }
  const kids: ReactNode[] = [0, 0.25, 0.5, 0.75, 1].flatMap(ratio => [
    <line
      key={`gl${ratio}`}
      x1={left}
      x2={width - right}
      y1={topChart + ratio * plotHeight}
      y2={topChart + ratio * plotHeight}
      className="usageTrendGrid"
    />,
    <text
      key={`glt${ratio}`}
      x={left - 6}
      y={topChart + ratio * plotHeight + 3.5}
      textAnchor="end"
      className="usageTrendAxis"
    >
      {Math.round((1 - ratio) * 100) + '%'}
    </text>,
    <text
      key={`grt${ratio}`}
      x={width - right + 6}
      y={topChart + ratio * plotHeight + 3.5}
      className="usageTrendAxis"
    >
      {String(Math.round(maxSpeed * (1 - ratio)))}
    </text>,
  ])
  models.forEach((m, index) => {
    const centerX = left + groupWidth * index + groupWidth / 2
    const hitHeight = (m.hitRate ?? 0) * plotHeight
    const speedHeight = ((m.speedTokensPerSec ?? 0) / maxSpeed) * plotHeight
    kids.push(
      <rect key={`h${m.model}`} x={centerX - barWidth - 2} y={topChart + plotHeight - hitHeight} width={barWidth} height={hitHeight} rx={2} fill={HIT_FILL} />,
      <rect key={`s${m.model}`} x={centerX + 2} y={topChart + plotHeight - speedHeight} width={barWidth} height={speedHeight} rx={2} fill={SPEED_FILL} />,
    )
    const name = m.model.slice(m.model.indexOf('/') + 1)
    const short = name.length > 10 ? name.slice(0, 9) + '…' : name
    kids.push(
      <text key={`x${m.model}`} x={centerX} y={height - 10} textAnchor="middle" className="usageTrendAxis">
        {short}
      </text>,
      <rect
        key={`c${m.model}`}
        x={left + groupWidth * index}
        y={topChart}
        width={groupWidth}
        height={plotHeight}
        className="usageQualityHover"
        onMouseEnter={() => setHover(m)}
        onMouseLeave={() => setHover(null)}
      />,
    )
  })
  const tip = hover === null ? null : (
    <div className="usageTipCard" style={{ left: '50%', top: 4, transform: 'translateX(-50%)' }}>
      <div className="usageTipTitle">{hover.model}</div>
      <div className="usageTipRow">
        <span className="usageTipSwatch" style={{ background: HIT_FILL }} />
        缓存命中
        <span className="usageTipValue">
          {hover.hitRate === null ? '—' : Math.round(hover.hitRate * 1000) / 10 + '%'}
        </span>
      </div>
      <div className="usageTipRow">
        <span className="usageTipSwatch" style={{ background: SPEED_FILL }} />
        输出速度
        <span className="usageTipValue">
          {hover.speedTokensPerSec === null ? '—' : Math.round(hover.speedTokensPerSec * 10) / 10 + ' tok/s'}
        </span>
      </div>
    </div>
  )
  return (
    <div className="usageQualityWrap">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="模型质量">
        {kids}
      </svg>
      {tip}
      <ul className="usageLegend">
        <li className="usageLegendItem">
          <span className="usageTipSwatch" style={{ background: HIT_FILL }} />
          缓存命中
        </li>
        <li className="usageLegendItem">
          <span className="usageTipSwatch" style={{ background: SPEED_FILL }} />
          输出速度 tok/s
        </li>
      </ul>
    </div>
  )
}

