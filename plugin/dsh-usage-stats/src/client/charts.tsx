/**
 * Hand-written SVG charts for the usage-stats page: a GitHub-style activity
 * heatmap, a multi-series daily trend, and a share donut. No chart library —
 * the client bundle purity gate forbids third-party deps; each chart is a
 * hundred-line component over plain coordinates. Colors resolve exclusively
 * through `--dsw-*` tokens.
 *
 * @module dsh-usage-stats/client/charts
 */

import type { ReactNode } from 'react'
import type { UsageStatsActivity, UsageStatsBreakdown, UsageStatsDaily } from '../types.ts'
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

/** Short month label (“9月” / “Sep”) derived from the key, locale-agnostic digits. */
function monthOf(dateKey: string): number {
  return Number(dateKey.slice(5, 7))
}

interface HeatmapProps {
  activity: UsageStatsActivity
  t: Translate
  format: (value: number) => string
}

/** GitHub-style activity grid: 7 weekday rows × ~52 week columns (weekly mode: one row). */
export function ActivityHeatmap({ activity, t, format }: HeatmapProps): ReactNode {
  const cell = 10
  const gap = 2
  const step = cell + gap
  const weekly = activity.mode === 'weekly'
  const rows = weekly ? 1 : 7
  const columns = weekly
    ? activity.cells.length
    : Math.ceil(activity.cells.length / 7)
  const left = 20
  const top = 16
  const width = left + columns * step
  const height = top + rows * step
  const weekdayLabels = ['', '一', '二', '三', '四', '五', '']
  const monthMarks: Array<{ x: number, label: string }> = []
  let lastMonth = -1
  for (let column = 0; column < columns; column += 1) {
    const anchor = weekly ? activity.cells[column] : activity.cells[column * 7]
    if (anchor === undefined) continue
    const month = monthOf(anchor.date)
    if (month !== lastMonth) {
      monthMarks.push({ x: left + column * step, label: String(month) })
      lastMonth = month
    }
  }
  return (
    <svg className="usageHeatmap" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={t('heatmap.title')}>
      {monthMarks.map(mark => (
        <text key={mark.x} x={mark.x} y={10} className="usageHeatAxis">
          {mark.label}
        </text>
      ))}
      {!weekly && weekdayLabels.map((label, index) => (
        label === ''
          ? null
          : (
            <text key={index} x={left - 4} y={top + index * step + cell - 1} textAnchor="end" className="usageHeatAxis">
              {label}
            </text>
          )
      ))}
      {activity.cells.map((cellData, index) => {
        const column = weekly ? index : Math.floor(index / 7)
        const row = weekly ? 0 : weekdayOf(cellData.date)
        const x = left + column * step
        const y = top + row * step
        const label = weekly
          ? t('heatmap.cell.week', { date: cellData.date, tokens: format(cellData.total) })
          : t('heatmap.cell.day', { date: cellData.date, tokens: format(cellData.total) })
        return (
          <rect
            key={cellData.date}
            x={x}
            y={y}
            width={cell}
            height={cell}
            rx={2}
            className="usageHeatCell"
            fill={HEAT_FILLS[Math.min(4, Math.max(0, cellData.level))]}
          >
            <title>{label}</title>
          </rect>
        )
      })}
    </svg>
  )
}

/** Heat legend swatches rendered beside the heatmap. */
export function HeatLegend({ activity, t, format }: HeatmapProps): ReactNode {
  void activity
  void format
  return (
    <span className="usageHeatLegend">
      <span className="usageHeatLegendLabel">{t('heatmap.legend.less')}</span>
      {HEAT_FILLS.map(fill => (
        <span key={fill} className="usageHeatSwatch" style={{ background: fill }} />
      ))}
      <span className="usageHeatLegendLabel">{t('heatmap.legend.more')}</span>
    </span>
  )
}

interface TrendProps {
  daily: UsageStatsDaily
  t: Translate
  format: (value: number) => string
  colors: ReadonlyMap<string, string>
}

/** Catmull-Rom-smoothed multi-series line chart of daily totals per model. */
export function TrendChart({ daily, t, format, colors }: TrendProps): ReactNode {
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
  return (
    <svg className="usageTrend" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={t('trend.title')}>
      {[0, 0.25, 0.5, 0.75, 1].map(ratio => {
        const value = gridMax * (1 - ratio)
        const y = topChart + ratio * plotHeight
        return (
          <g key={ratio}>
            <line x1={left} x2={width - right} y1={y} y2={y} className="usageTrendGrid" />
            <text x={left - 6} y={y + 3.5} textAnchor="end" className="usageTrendAxis">
              {format(value)}
            </text>
          </g>
        )
      })}
      {tickIndexes.map(index => (
        <text key={index} x={xOf(index)} y={height - 8} textAnchor="middle" className="usageTrendAxis">
          {dateLabel(index)}
        </text>
      ))}
      {[...series.entries()].map(([model, line]) => (
        <path
          key={model}
          className="usageTrendLine"
          stroke={colors.get(model) ?? seriesColor([...series.keys()].indexOf(model))}
          d={smoothPath(line.map((value, index) => [xOf(index), yOf(value)]))}
        />
      ))}
    </svg>
  )
}

interface DonutProps {
  breakdown: UsageStatsBreakdown
  colors: ReadonlyMap<string, string>
}

/** Donut of share slices around a centered total (foreign-free, plain SVG). */
export function DonutChart({ breakdown, colors }: DonutProps): ReactNode {
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
      />
    )
    offset += dash
    return arc
  })
  void breakdown.total
  return (
    <svg className="usageDonut" viewBox={`0 0 ${size} ${size}`} role="img">
      {arcs}
    </svg>
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
