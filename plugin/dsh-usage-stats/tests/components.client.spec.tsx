// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { UsageStatsSection } from '../src/client/UsageStatsSection.tsx'
import type { UsageStatsFace, UsageStatsSectionProps } from '../src/client/UsageStatsSection.tsx'
import { en, zh } from '../src/client/locales.ts'
import type { UsageStatsLocaleKey } from '../src/client/locales.ts'
import type { UsageStatsLang } from '../src/client/format.ts'
import styles from '../src/client/UsageStatsSection.module.css'
import type {
  UsageStatsActivity,
  UsageStatsBreakdown,
  UsageStatsDaily,
  UsageStatsSummary,
} from '../src/types.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

type Translate = (key: UsageStatsLocaleKey, params?: Record<string, string | number>) => string

/** Dictionary-backed translate (params substituted like the runtime one). */
function translator(dict: Record<string, string>): Translate {
  return (key, params) => {
    let text: string = dict[key] ?? key
    for (const [name, value] of Object.entries(params ?? {})) text = text.replaceAll(`{${name}}`, String(value))
    return text
  }
}

const tZh = translator(zh)
const tEn = translator(en)

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

// ── Fixtures ──────────────────────────────────────────────────────────────

const SUMMARY: UsageStatsSummary = {
  totalTokens: 15_400,
  peakTokens: 2_000,
  longestChatMs: 3_600_000,
  currentStreakDays: 3,
  longestStreakDays: 7,
  activeDays: 9,
  firstDate: '2026-09-01',
  lastDate: '2026-09-10',
  speedTokensPerSec: 31.66,
  avgCallMs: 41 * 60_000,
  cacheHitRate: 0.942,
  calls: 120,
  generatedAt: Date.now() - 60_000,
}

function activityFixture(mode: UsageStatsActivity['mode'] = 'daily'): UsageStatsActivity {
  const cells = []
  for (let i = 0; i < 52 * 7; i += 1) {
    cells.push({ date: `2025-10-${String((i % 28) + 1).padStart(2, '0')}`, total: (i % 5) * 1000, calls: i % 5, level: i % 5 })
  }
  return { mode, cells, maxTotal: 4000 }
}

function dailyFixture(model: string, days: number): UsageStatsDaily {
  return {
    days: Array.from({ length: days }, (_, i) => ({
      date: `2026-09-${String(i + 1).padStart(2, '0')}`,
      total: 1000 * (i + 1),
      byModel: i === 0 ? [] : [{ model: `p/${model}`, tokens: 1000 * (i + 1) }],
    })),
  }
}

function breakdownFixture(model: string): UsageStatsBreakdown {
  return {
    dim: 'model',
    total: 6000,
    slices: [{ key: `p/${model}`, label: model, tokens: 6000, share: 1 }],
  }
}

/** Scripted face: every call returns a fresh deferred the test resolves. */
interface Scripted {
  face: UsageStatsFace
  calls: {
    summary: Array<ReturnType<typeof deferred<UsageStatsSummary>>>
    activity: Array<{ mode: UsageStatsActivity['mode'], d: ReturnType<typeof deferred<UsageStatsActivity>> }>
    range: Array<{ arg: unknown, d: ReturnType<typeof deferred<UsageStatsDaily>> }>
    breakdown: Array<{ arg: unknown, d: ReturnType<typeof deferred<UsageStatsBreakdown>> }>
  }
}

function scriptedFace(): Scripted {
  const calls: Scripted['calls'] = { summary: [], activity: [], range: [], breakdown: [] }
  const quality = vi.fn(async () => ({ models: [] }))
  const face: UsageStatsFace = {
    summary: () => {
      const d = deferred<UsageStatsSummary>()
      calls.summary.push(d)
      return d.promise
    },
    activity: (mode: UsageStatsActivity['mode']) => {
      const d = deferred<UsageStatsActivity>()
      calls.activity.push({ mode, d })
      return d.promise
    },
    daily: (arg: unknown) => {
      const d = deferred<UsageStatsDaily>()
      calls.range.push({ arg, d })
      return d.promise
    },
    breakdown: (arg: unknown) => {
      const d = deferred<UsageStatsBreakdown>()
      calls.breakdown.push({ arg, d })
      return d.promise
    },
    quality: quality as UsageStatsFace['quality'],
  }
  return { face, calls }
}

/** Resolve the i-th pending range round (daily + breakdown together). */
function resolveRange(scripted: Scripted, index: number, model: string, days: number): void {
  scripted.calls.range[index]!.d.resolve(dailyFixture(model, days))
  scripted.calls.breakdown[index]!.d.resolve(breakdownFixture(model))
}

function renderSection(scripted: Scripted, lang: UsageStatsLang = 'zh', t: Translate = tZh): void {
  const props: UsageStatsSectionProps = { face: scripted.face, t, lang: () => lang }
  render(<UsageStatsSection {...props} />)
}

/** Fast-forward one complete load: summary + activity + range round 0. */
async function settle(scripted: Scripted, activity = activityFixture()): Promise<void> {
  await waitFor(() => expect(scripted.calls.summary.length).toBeGreaterThanOrEqual(1))
  scripted.calls.summary[0]!.resolve(SUMMARY)
  scripted.calls.activity[0]!.d.resolve(activity)
  resolveRange(scripted, 0, 'alpha', 7)
  await screen.findByText('1.5万')
}

/** SVG <title> texts present in the document. */
function svgTitles(): string[] {
  return [...document.querySelectorAll('svg title')].map(el => el.textContent ?? '')
}

/** The two custom-range date inputs, looked up through their labels. */
function dateInputs(): HTMLInputElement[] {
  return [screen.getByLabelText('开始日期'), screen.getByLabelText('结束日期')] as HTMLInputElement[]
}

// ── Specs ─────────────────────────────────────────────────────────────────

describe('UsageStatsSection', () => {
  it('renders module classes, never raw usage* class strings', async () => {
    const scripted = scriptedFace()
    renderSection(scripted)
    await settle(scripted)
    const root = document.querySelector('section')
    expect(root).not.toBeNull()
    expect(root!.className).toContain(styles.section)
    // No element may carry an unhashed usage* class (the P0 failure mode).
    const offenders = [...document.querySelectorAll('[class*="usage"]')]
    expect(offenders).toEqual([])
  })

  it('shows the loading state before the first summary resolves', () => {
    const scripted = scriptedFace()
    renderSection(scripted)
    expect(screen.getByText('正在读取统计…')).toBeTruthy()
  })

  it('renders the summary band, heatmap, stacked trend, and donut from data', async () => {
    const scripted = scriptedFace()
    renderSection(scripted)
    await settle(scripted)
    // Summary band values (zh profile).
    expect(screen.getByText('1.5万')).toBeTruthy()
    expect(screen.getByText('94.2%')).toBeTruthy()
    expect(screen.getByText('31.7 tok/s')).toBeTruthy()
    expect(screen.getByText('41 分钟')).toBeTruthy()
    // Meta line composes time, first date, and active days.
    expect(screen.getByText(/自 9月1日 起 · 活跃 9 天/)).toBeTruthy()
    // Charts: heatmap SVG with weekday labels, stacked-bar SVG, donut ring.
    expect(svgTitles()).toContain('活动')
    expect(svgTitles()).toContain('按日 Token 趋势')
    expect(svgTitles()).toContain('模型用量')
    // The donut ranking and the trend legend both carry the series.
    expect((await screen.findAllByText('alpha')).length).toBeGreaterThanOrEqual(2)
  })

  it('shows the empty state instead of charts when nothing was collected', async () => {
    const scripted = scriptedFace()
    renderSection(scripted)
    await waitFor(() => expect(scripted.calls.summary.length).toBeGreaterThan(0))
    scripted.calls.summary[0]!.resolve({ ...SUMMARY, totalTokens: 0, activeDays: 0, firstDate: null, cacheHitRate: null, speedTokensPerSec: null, avgCallMs: null })
    scripted.calls.activity[0]!.d.resolve(activityFixture())
    resolveRange(scripted, 0, 'alpha', 7)
    expect(await screen.findByText(/暂无数据/)).toBeTruthy()
    expect(screen.queryByTitle('按日 Token 趋势')).toBeNull()
  })

  it('isolates a failed group: activity error shows with retry, trend stays', async () => {
    const scripted = scriptedFace()
    renderSection(scripted)
    await waitFor(() => expect(scripted.calls.summary.length).toBeGreaterThan(0))
    scripted.calls.summary[0]!.resolve(SUMMARY)
    scripted.calls.activity[0]!.d.reject(new Error('boom'))
    resolveRange(scripted, 0, 'alpha', 7)
    expect(await screen.findByText('读取失败：boom')).toBeTruthy()
    // The trend and donut from the successful range group still render.
    expect((await screen.findAllByText('alpha')).length).toBeGreaterThan(0)
    // Retry reloads only the activity group.
    const before = scripted.calls.summary.length
    fireEvent.click(screen.getByText('重试'))
    await waitFor(() => expect(scripted.calls.activity.length).toBe(2))
    expect(scripted.calls.summary.length).toBe(before)
    scripted.calls.activity[1]!.d.resolve(activityFixture('weekly'))
  })

  it('switching daily/weekly requests ONLY the activity group with the mode', async () => {
    const scripted = scriptedFace()
    renderSection(scripted)
    await settle(scripted)
    fireEvent.click(screen.getByText('每周'))
    await waitFor(() => expect(scripted.calls.activity.length).toBe(2))
    expect(scripted.calls.activity[1]!.mode).toBe('weekly')
    expect(scripted.calls.summary.length).toBe(1)
    expect(scripted.calls.range.length).toBe(1)
    scripted.calls.activity[1]!.d.resolve(activityFixture('weekly'))
  })

  it('switching to 30 days immediately requests the new range parameter', async () => {
    const scripted = scriptedFace()
    renderSection(scripted)
    await settle(scripted)
    expect(scripted.calls.range[0]!.arg).toEqual({ range: 7 })
    fireEvent.click(screen.getByText('近 30 天'))
    await waitFor(() => expect(scripted.calls.range.length).toBe(2))
    expect(scripted.calls.range[1]!.arg).toEqual({ range: 30 })
    resolveRange(scripted, 1, 'beta', 30)
    expect((await screen.findAllByText('beta')).length).toBeGreaterThan(0)
  })

  it('custom range: valid dates request from/to; invalid ones block and explain', async () => {
    const scripted = scriptedFace()
    renderSection(scripted)
    await settle(scripted)
    fireEvent.click(screen.getByText('自定义'))
    const inputs = dateInputs()
    expect(inputs.length).toBe(2)
    expect(inputs[0]!.getAttribute('aria-label')).toBe('开始日期')
    // Switching to custom first fires one request for the valid defaults.
    await waitFor(() => expect(scripted.calls.range.length).toBe(2))
    expect(scripted.calls.range[1]!.arg).toEqual({ from: inputs[0]!.value, to: inputs[1]!.value })
    // from > to (far future start is invalid against ANY default end — the
    // sequence stays deterministic regardless of the real clock).
    fireEvent.change(inputs[0], { target: { value: '2999-01-01' } })
    fireEvent.change(inputs[1], { target: { value: '2026-09-01' } })
    expect(await screen.findByText('开始日期不能晚于结束日期。')).toBeTruthy()
    expect(screen.queryByText('alpha')).toBeNull()
    expect(scripted.calls.range.length).toBe(2)
    // Fix the span → one request with the exact wire range.
    fireEvent.change(inputs[0], { target: { value: '2026-09-01' } })
    await waitFor(() => expect(scripted.calls.range.length).toBe(3))
    expect(scripted.calls.range[2]!.arg).toEqual({ from: '2026-09-01', to: '2026-09-01' })
    resolveRange(scripted, 2, 'gamma', 0)
    // Missing date → missing-state message, still no request.
    fireEvent.change(inputs[0], { target: { value: '' } })
    expect(await screen.findByText('请补全开始与结束日期。')).toBeTruthy()
    expect(scripted.calls.range.length).toBe(3)
  })

  it('rejects custom spans beyond 120 days before any request', async () => {
    const scripted = scriptedFace()
    renderSection(scripted)
    await settle(scripted)
    fireEvent.click(screen.getByText('自定义'))
    const inputs = dateInputs()
    fireEvent.change(inputs[0], { target: { value: '2026-01-01' } })
    fireEvent.change(inputs[1], { target: { value: '2026-09-01' } })
    expect(await screen.findByText(/最多 120 天/)).toBeTruthy()
    // One initial + one custom-defaults request, never one for the bad span.
    expect(scripted.calls.range.length).toBe(2)
    expect(scripted.calls.range.every(call => call.arg !== undefined)).toBeTruthy()
  })

  it('a stale range response can never overwrite a newer selection', async () => {
    const scripted = scriptedFace()
    renderSection(scripted)
    // Round 0 (7d) stays pending; switch to 30d and resolve THAT first.
    await waitFor(() => expect(scripted.calls.range.length).toBe(1))
    scripted.calls.summary[0]!.resolve(SUMMARY)
    scripted.calls.activity[0]!.d.resolve(activityFixture())
    await screen.findByText('1.5万')
    fireEvent.click(screen.getByText('近 30 天'))
    await waitFor(() => expect(scripted.calls.range.length).toBe(2))
    resolveRange(scripted, 1, 'beta', 30)
    expect((await screen.findAllByText('beta')).length).toBeGreaterThan(0)
    // The late 7-day response arrives after — it must be dropped.
    resolveRange(scripted, 0, 'alpha', 7)
    await waitFor(() => expect(screen.getAllByText('beta').length).toBeGreaterThan(0))
    expect(screen.queryByText('alpha')).toBeNull()
  })

  it('refresh reloads all three groups and announces completion once', async () => {
    const scripted = scriptedFace()
    renderSection(scripted)
    await settle(scripted)
    // The initial load must NOT announce (quiet panel, no constant chatter).
    expect(screen.queryByRole('status')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    await waitFor(() => expect(scripted.calls.summary.length).toBe(2))
    await waitFor(() => expect(scripted.calls.activity.length).toBe(2))
    await waitFor(() => expect(scripted.calls.range.length).toBe(2))
    // The announce lands only after the whole refresh round settles.
    expect(screen.queryByRole('status')).toBeNull()
    scripted.calls.summary[1]!.resolve(SUMMARY)
    scripted.calls.activity[1]!.d.resolve(activityFixture())
    resolveRange(scripted, 1, 'alpha', 7)
    const status = await screen.findByRole('status')
    expect(status.textContent).toBe('统计已刷新。')
  })

  it('window focus refetches every group', async () => {
    const scripted = scriptedFace()
    renderSection(scripted)
    await settle(scripted)
    fireEvent(window, new Event('focus'))
    await waitFor(() => expect(scripted.calls.summary.length).toBe(2))
    await waitFor(() => expect(scripted.calls.range.length).toBe(2))
  })

  it('renders the English profile with zero Chinese residue', async () => {
    const scripted = scriptedFace()
    renderSection(scripted, 'en', tEn)
    await waitFor(() => expect(scripted.calls.summary.length).toBeGreaterThan(0))
    scripted.calls.summary[0]!.resolve(SUMMARY)
    scripted.calls.activity[0]!.d.resolve(activityFixture())
    resolveRange(scripted, 0, 'alpha', 7)
    await screen.findByText('15.4K')
    const chinese = [...document.querySelectorAll('body *')]
      .filter(el => el.children.length === 0 && /[\u4e00-\u9fff]/.test(el.textContent ?? ''))
    expect(chinese.map(el => el.textContent)).toEqual([])
    expect(screen.getByText(/Since Sep 1 · 9 active days/)).toBeTruthy()
    expect(screen.getByText('41 min')).toBeTruthy()
  })

  it('keeps the previous range data on screen while refetching', async () => {
    const scripted = scriptedFace()
    renderSection(scripted)
    await settle(scripted)
    fireEvent.click(screen.getByText('近 30 天'))
    await waitFor(() => expect(scripted.calls.range.length).toBe(2))
    // Round 1 still pending — round 0's model stays visible (no loading flash).
    expect(screen.getAllByText('alpha').length).toBeGreaterThan(0)
    expect(screen.queryByText('正在读取统计…')).toBeNull()
  })
})
