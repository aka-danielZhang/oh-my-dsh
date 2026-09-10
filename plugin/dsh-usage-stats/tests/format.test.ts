import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  daysBetween,
  formatDateFull,
  formatDateShort,
  formatDateWithImplicitYear,
  formatDuration,
  formatPercent,
  formatRelative,
  formatShare,
  formatSpeed,
  formatTokens,
  formatTokensAxis,
  localDateKey,
  localDaysAgoKey,
  resolveLang,
} from '../src/client/format.ts'

test('formatTokens: zh boundaries — 万 below 1e8, 亿 above, 9,999 stays grouped', () => {
  assert.equal(formatTokens(999, 'zh'), '999')
  assert.equal(formatTokens(9_999, 'zh'), '9,999')
  assert.equal(formatTokens(12_345, 'zh'), '1.2万')
  assert.equal(formatTokens(99_999, 'zh'), '10万')
  // The redesign's regression case: 500,000,000 must be 5亿, not 5万.
  assert.equal(formatTokens(500_000_000, 'zh'), '5亿')
  assert.equal(formatTokens(1_000_000_000, 'zh'), '10亿')
  // A rounded 10000万 promotes to 1亿 instead of overflowing the scale.
  assert.equal(formatTokens(99_999_999, 'zh'), '1亿')
})

test('formatTokens: en boundaries — K/M/B, never the zh 万 suffix', () => {
  assert.equal(formatTokens(999, 'en'), '999')
  assert.equal(formatTokens(1_000, 'en'), '1K')
  assert.equal(formatTokens(9_999, 'en'), '10K')
  assert.equal(formatTokens(12_345, 'en'), '12.3K')
  assert.equal(formatTokens(999_999, 'en'), '1M')
  // The redesign's regression cases: 500M and 1B (the old divider printed
  // 5万 and 1M here).
  assert.equal(formatTokens(500_000_000, 'en'), '500M')
  assert.equal(formatTokens(1_000_000_000, 'en'), '1B')
  assert.ok(!formatTokens(12_345, 'en').includes('万'))
  assert.ok(!formatTokens(12_345, 'en').includes('w'))
})

test('formatTokensAxis: same scales, shorter labels for gutters', () => {
  assert.equal(formatTokensAxis(9_999, 'zh'), '9999')
  assert.equal(formatTokensAxis(10_000_000, 'zh'), '1000万')
  assert.equal(formatTokensAxis(100_000_000, 'zh'), '1亿')
  assert.equal(formatTokensAxis(12_345, 'en'), '12.3K')
  assert.equal(formatTokensAxis(1_500_000, 'en'), '1.5M')
})

test('formatTokens: non-finite degrades to a dash', () => {
  assert.equal(formatTokens(Number.NaN, 'zh'), '—')
  assert.equal(formatTokens(Number.POSITIVE_INFINITY, 'en'), '—')
})

test('formatShare / formatPercent / formatSpeed', () => {
  assert.equal(formatShare(0), '0%')
  assert.equal(formatShare(0.4231), '42.3%')
  assert.equal(formatShare(1), '100%')
  assert.equal(formatShare(Number.NaN), '0%')
  assert.equal(formatPercent(null), '—')
  assert.equal(formatPercent(0.942), '94.2%')
  assert.equal(formatSpeed(null), '—')
  assert.equal(formatSpeed(31.66), '31.7 tok/s')
})

test('formatDuration: seconds, minutes, and hours in both profiles', () => {
  assert.equal(formatDuration(null, 'zh'), '—')
  assert.equal(formatDuration(0, 'en'), '—')
  assert.equal(formatDuration(500, 'zh'), '1 s')
  assert.equal(formatDuration(41_200, 'en'), '41 s')
  assert.equal(formatDuration(59_999, 'zh'), '59 s')
  assert.equal(formatDuration(5 * 60_000, 'zh'), '5 分钟')
  assert.equal(formatDuration(65 * 60_000, 'zh'), '1 小时 5 分')
  assert.equal(formatDuration(65 * 60_000, 'en'), '1 h 5 min')
  assert.equal(formatDuration(2 * 3_600_000, 'en'), '2 h')
})

test('formatRelative ages', () => {
  const now = 1_000_000_000_000
  assert.equal(formatRelative(now - 30_000, 'zh', now), '刚刚')
  assert.equal(formatRelative(now - 5 * 60_000, 'zh', now), '5 分钟前')
  assert.equal(formatRelative(now - 3 * 3_600_000, 'en', now), '3 h ago')
})

test('dates: zh uses M月D日, en uses locale short dates', () => {
  assert.equal(formatDateShort('2026-09-06', 'zh'), '9月6日')
  assert.equal(formatDateShort('2026-09-06', 'en'), 'Sep 6')
  assert.equal(formatDateFull('2026-01-09', 'zh'), '2026年1月9日')
  assert.equal(formatDateFull('2026-01-09', 'en'), 'January 9, 2026')
  // Unparseable keys pass through untouched rather than throwing.
  assert.equal(formatDateShort('garbage', 'zh'), 'garbage')
})

test('dates: implicit-year form keeps the year only when it differs', () => {
  const now = new Date(2026, 8, 10)
  assert.equal(formatDateWithImplicitYear('2026-09-08', 'zh', now), '9月8日')
  assert.equal(formatDateWithImplicitYear('2025-09-08', 'zh', now), '2025年9月8日')
  assert.equal(formatDateWithImplicitYear('2025-09-08', 'en', now), 'September 8, 2025')
})

test('local date keys never cross days via UTC', () => {
  // 2026-09-10 00:30 in a UTC+8 environment is 2026-09-09 16:30 UTC — the
  // old toISOString() approach produced the wrong calendar day there.
  const local = new Date(2026, 8, 10, 0, 30)
  assert.equal(localDateKey(local), '2026-09-10')
  assert.equal(localDaysAgoKey(0, local), '2026-09-10')
  assert.equal(localDaysAgoKey(29, local), '2026-08-12')
  // Month and year rollovers stay on the local calendar.
  const ny = new Date(2026, 0, 1)
  assert.equal(localDaysAgoKey(1, ny), '2025-12-31')
})

test('daysBetween spans and rejects unparseable keys', () => {
  assert.equal(daysBetween('2026-09-01', '2026-09-07'), 6)
  assert.equal(daysBetween('2026-09-07', '2026-09-01'), -6)
  assert.ok(Number.isNaN(daysBetween('x', '2026-09-01')))
})

test('resolveLang maps locale ids onto the two profiles', () => {
  assert.equal(resolveLang('zh'), 'zh')
  assert.equal(resolveLang('zh-TW'), 'zh')
  assert.equal(resolveLang('en-US'), 'en')
  assert.equal(resolveLang('fr'), 'en')
})
