/**
 * Dynamic-plugin PREVIEW Host half — the exact text of cordis_define's
 * `code.host` body (dev-only; the shipped plugin's Host half is src/fold.ts +
 * src/gateway.ts). Reads the real `$DSH_HOME/usage-stats/records/*.jsonl`
 * through the Host `fs` service, folds them with the same metric definitions
 * as src/fold.ts, and answers the Client's Package-private RPC.
 * scripts/build-dynamic-preview.mjs copies this file to .preview/host-body.js.
 */
const RECORDS_SUFFIX = '/usage-stats/records'
const HOME_CANDIDATES = ['~/.dsh', '/Users/kingdee/.dsh']

function dateKeyOf(t, utcOffsetMinutes) {
  const shifted = new Date(t + utcOffsetMinutes * 60000)
  const year = shifted.getUTCFullYear()
  const month = String(shifted.getUTCMonth() + 1).padStart(2, '0')
  const day = String(shifted.getUTCDate()).padStart(2, '0')
  return year + '-' + month + '-' + day
}

function dayIndexOf(dateKey) {
  return Math.floor(Date.parse(dateKey + 'T00:00:00.000Z') / 86400000)
}

function dateKeyOfIndex(dayIndex) {
  return dateKeyOf(dayIndex * 86400000, 0)
}

function applyRecord(days, record, dateKey) {
  let day = days[dateKey]
  if (day === undefined) {
    day = { total: 0, peak: 0, calls: 0, byModel: {} }
    days[dateKey] = day
  }
  const total = record.in + record.out + (record.cr || 0) + (record.cw || 0)
  const billed = record.in + (record.cr || 0) + (record.cw || 0)
  day.total += total
  if (total > day.peak) day.peak = total
  day.calls += 1
  const key = record.provider + '/' + record.model
  let bucket = day.byModel[key]
  if (bucket === undefined) {
    bucket = { tokens: 0, cr: 0, billed: 0, out: 0, durMs: 0, durSamples: 0 }
    day.byModel[key] = bucket
  }
  bucket.tokens += total
  bucket.cr += record.cr || 0
  bucket.billed += billed
  bucket.out += record.out
  if (typeof record.sd === 'number' && record.sd > 0 && record.sd < record.t) {
    bucket.durMs += record.t - record.sd
    bucket.durSamples += 1
  }
}

function parseRecordsInto(days, text) {
  for (const line of text.split('\n')) {
    if (line.length === 0) continue
    let record
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    if (record === null || typeof record !== 'object') continue
    if (record.v !== 1) continue
    if (typeof record.t !== 'number' || !Number.isFinite(record.t)) continue
    if (typeof record.provider !== 'string' || typeof record.model !== 'string') continue
    if (typeof record.in !== 'number' || typeof record.out !== 'number') continue
    applyRecord(days, record, dateKeyOf(record.t, -new Date().getTimezoneOffset()))
  }
}

async function loadDays(fs) {
  let lastError = 'records directory unreachable'
  for (const home of HOME_CANDIDATES) {
    const dir = home + RECORDS_SUFFIX
    let target
    try {
      target = await fs.resolve(dir)
    } catch (error) {
      lastError = String(error && error.message ? error.message : error)
      continue
    }
    let entries
    try {
      entries = await fs.listDir(target)
    } catch (error) {
      lastError = String(error && error.message ? error.message : error)
      continue
    }
    const days = {}
    for (const entry of entries) {
      const name = typeof entry === 'string'
        ? entry
        : entry && typeof entry.name === 'string'
          ? entry.name
          : entry && typeof entry.path === 'string'
            ? entry.path
            : undefined
      if (typeof name !== 'string') continue
      const base = name.slice(name.lastIndexOf('/') + 1)
      if (!base.endsWith('.jsonl')) continue
      const full = name.indexOf('/') === 0 ? name : dir + '/' + base
      let text
      try {
        text = await fs.readText(await fs.resolve(full))
      } catch (error) {
        lastError = String(error && error.message ? error.message : error)
        continue
      }
      parseRecordsInto(days, text)
    }
    return days
  }
  throw new Error(lastError)
}

function rangeDateKeysOf(now, offsetMinutes, spec) {
  if (spec && typeof spec.from === 'string' && typeof spec.to === 'string') {
    const start = dayIndexOf(spec.from)
    const end = dayIndexOf(spec.to)
    if (Number.isFinite(start) && Number.isFinite(end) && start <= end && end - start <= 120) {
      const keys = []
      for (let i = start; i <= end; i += 1) keys.push(dateKeyOfIndex(i))
      return keys
    }
  }
  const days = spec && Number.isFinite(spec.range) && spec.range > 0 ? Math.floor(spec.range) : 7
  const todayIndex = dayIndexOf(dateKeyOf(now, offsetMinutes))
  const keys = []
  for (let i = days - 1; i >= 0; i -= 1) keys.push(dateKeyOfIndex(todayIndex - i))
  return keys
}

function weekStartOf(dateKey) {
  const index = dayIndexOf(dateKey)
  const dow = (index + 3) % 7
  return dateKeyOfIndex(index - dow)
}

function levelOf(total, maxTotal) {
  if (total <= 0) return 0
  if (maxTotal <= 0) return 1
  return Math.min(4, Math.max(1, Math.ceil((total / maxTotal) * 4)))
}

function summarize(days, now, offsetMinutes) {
  const keys = Object.keys(days)
  let totalTokens = 0
  let peakTokens = 0
  let calls = 0
  let cr = 0
  let billed = 0
  let out = 0
  let durMs = 0
  let durSamples = 0
  for (const day of Object.values(days)) {
    totalTokens += day.total
    if (day.peak > peakTokens) peakTokens = day.peak
    calls += day.calls
    for (const bucket of Object.values(day.byModel)) {
      cr += bucket.cr
      billed += bucket.billed
      out += bucket.out
      durMs += bucket.durMs
      durSamples += bucket.durSamples
    }
  }
  const sorted = keys.slice().sort()
  const todayIndex = dayIndexOf(dateKeyOf(now, offsetMinutes))
  const indexes = [...new Set(keys)].map(dayIndexOf).sort((a, b) => a - b)
  let longest = indexes.length > 0 ? 1 : 0
  let run = 1
  let current = 0
  for (let i = 1; i <= indexes.length; i += 1) {
    const contiguous = i < indexes.length && indexes[i] === indexes[i - 1] + 1
    if (contiguous) {
      run += 1
    } else {
      if (run > longest) longest = run
      if (indexes[i - 1] >= todayIndex - 1 && indexes[i - 1] <= todayIndex) current = run
      run = 1
    }
  }
  return {
    totalTokens,
    peakTokens,
    longestChatMs: 0,
    currentStreakDays: current,
    longestStreakDays: longest,
    activeDays: keys.length,
    firstDate: sorted.length > 0 ? sorted[0] : null,
    lastDate: sorted.length > 0 ? sorted[sorted.length - 1] : null,
    speedTokensPerSec: durMs > 0 ? out / (durMs / 1000) : null,
    avgCallMs: durSamples > 0 ? durMs / durSamples : null,
    cacheHitRate: billed > 0 ? cr / billed : null,
    calls,
    generatedAt: now,
  }
}

function dailySeries(days, now, offsetMinutes, spec) {
  const entries = []
  for (const date of rangeDateKeysOf(now, offsetMinutes, spec)) {
    const day = days[date]
    if (day === undefined) {
      entries.push({ date, total: 0, byModel: [] })
      continue
    }
    const byModel = Object.entries(day.byModel)
      .map(([model, bucket]) => ({ model, tokens: bucket.tokens }))
      .sort((a, b) => b.tokens - a.tokens || (a.model < b.model ? -1 : 1))
    entries.push({ date, total: day.total, byModel })
  }
  return { days: entries }
}

function activityCells(days, mode, now, offsetMinutes) {
  const todayIndex = dayIndexOf(dateKeyOf(now, offsetMinutes))
  const thisMonday = dayIndexOf(weekStartOf(dateKeyOfIndex(todayIndex)))
  const start = thisMonday - 51 * 7
  const keys = []
  for (let i = start; i <= thisMonday + 6; i += 1) keys.push(dateKeyOfIndex(i))
  const cells = []
  let maxTotal = 0
  if (mode === 'weekly') {
    const weeks = new Map()
    for (const key of keys) {
      const week = weekStartOf(key)
      const day = days[key]
      const acc = weeks.get(week) || { total: 0, calls: 0 }
      acc.total += day ? day.total : 0
      acc.calls += day ? day.calls : 0
      weeks.set(week, acc)
    }
    for (const value of weeks.values()) if (value.total > maxTotal) maxTotal = value.total
    for (const [date, value] of weeks) {
      cells.push({ date, total: value.total, calls: value.calls, level: levelOf(value.total, maxTotal) })
    }
    return { mode, cells, maxTotal }
  }
  let cumulative = 0
  for (const key of keys) {
    const day = days[key]
    const total = day ? day.total : 0
    if (mode === 'cumulative') {
      cumulative += total
      cells.push({ date: key, total: cumulative, calls: 0, level: 0 })
      if (cumulative > maxTotal) maxTotal = cumulative
    } else {
      cells.push({ date: key, total, calls: day ? day.calls : 0, level: 0 })
      if (total > maxTotal) maxTotal = total
    }
  }
  const settled = maxTotal
  for (const cell of cells) cell.level = levelOf(cell.total, settled)
  return { mode, cells, maxTotal }
}

function breakdownOf(days, now, offsetMinutes, spec) {
  const totals = new Map()
  let total = 0
  for (const date of rangeDateKeysOf(now, offsetMinutes, spec)) {
    const day = days[date]
    if (day === undefined) continue
    for (const [key, bucket] of Object.entries(day.byModel)) {
      totals.set(key, (totals.get(key) || 0) + bucket.tokens)
      total += bucket.tokens
    }
  }
  const slices = [...totals.entries()]
    .map(([key, tokens]) => ({
      key,
      label: key.slice(key.indexOf('/') + 1),
      tokens,
      share: total > 0 ? tokens / total : 0,
    }))
    .sort((a, b) => b.tokens - a.tokens || (a.key < b.key ? -1 : 1))
  return { dim: 'model', total, slices }
}

return {
  apply(ctx) {
    const fs = ctx.get('fs')
    if (fs === undefined) throw new Error('usage-stats-preview: fs service missing')
    const disposeRpc = harness.handle('usage-stats-preview:query', async (args) => {
      try {
        const request = args === null || typeof args !== 'object' ? {} : args
        const days = await loadDays(fs)
        const now = Date.now()
        const offset = -new Date().getTimezoneOffset()
        const spec = request.range === null || typeof request.range !== 'object' ? undefined : request.range
        switch (request.kind) {
          case 'summary':
            return { ok: true, value: summarize(days, now, offset) }
          case 'daily':
            return { ok: true, value: dailySeries(days, now, offset, spec) }
          case 'activity':
            return {
              ok: true,
              value: activityCells(
                days,
                request.mode === 'weekly' ? 'weekly' : request.mode === 'cumulative' ? 'cumulative' : 'daily',
                now,
                offset,
              ),
            }
          case 'breakdown':
            return { ok: true, value: breakdownOf(days, now, offset, spec) }
          case 'quality':
            return { ok: true, value: { models: [] } }
          default:
            return { ok: false, error: { code: 'BAD_KIND', message: String(request.kind) } }
        }
      } catch (error) {
        return { ok: false, error: { code: 'FOLD_FAILED', message: String(error && error.message ? error.message : error) } }
      }
    })
    return async () => { disposeRpc() }
  },
}
