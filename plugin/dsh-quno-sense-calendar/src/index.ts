/**
 * dsh-quno-sense-calendar — a REAL Sense over local iCalendar files.
 *
 * Modes: poll. Identity: the VEVENT UID plus a revision token
 * (SEQUENCE/LAST-MODIFIED/DTSTAMP/content hash). A change is emitted as a new
 * immutable event; a disappearance is an explicit retraction, never a silent
 * delete. Recurring rules are out of scope for v1 and declared honestly
 * (`changeCoverage: snapshot-diff`).
 *
 * @module dsh-quno-sense-calendar
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { EventEnvelope, IngestBatch, SenseDefinition } from '../../dsh-quno/src/types.ts'
import type { SenseFactory, SenseHandle, SenseRuntime } from '../../dsh-quno/src/senses.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-quno-sense-calendar'

/** Waits for the Quno Host to expose the Sense registry. */
export const inject = ['qunoSenses']

/** Minimal structural registry face (string-keyed service, instance-agnostic). */
interface SenseRegistryFace {
  register(definition: unknown, factory: unknown): () => Promise<void>
}

/** The declaration this Sense offers to Quno. */
export const definition: SenseDefinition = {
  type: 'quno/calendar',
  contractVersion: 'quno.sense/v1',
  implementationVersion: '0.1.0',
  displayName: '日历（本地 .ics）',
  description: '读取本地 iCalendar 文件目录，按 UID + 修订号追踪新增、改期与取消的日程。',
  eventTypes: [
    { type: 'calendar/event-updated', summary: '日程新增或改期' },
    { type: 'calendar/event-cancelled', summary: '日程被删除或取消' },
  ],
  configFields: [
    { key: 'directory', label: '日历目录', type: 'path', required: false, placeholder: '~/Calendar', help: '读取该目录下的 .ics 文件；与单文件二选一' },
    { key: 'file', label: '单个日历文件', type: 'path', required: false, placeholder: '~/Calendar/work.ics' },
    { key: 'intervalSec', label: '轮询间隔（秒）', type: 'number', defaultValue: 60, help: '最小 30 秒' },
    { key: 'maxFiles', label: '最多文件数', type: 'number', defaultValue: 50 },
    { key: 'timeZone', label: '浮动时间所属时区', type: 'string', defaultValue: 'Asia/Shanghai', help: '未带 TZID/Z 的时间按此时区解释' },
    { key: 'lookaheadDays', label: '向后看多少天', type: 'number', defaultValue: 30 },
    { key: 'freshnessThresholdSec', label: '陈旧阈值（秒）', type: 'number', defaultValue: 600 },
  ],
  permissions: {
    reads: ['local iCalendar files under the configured directory or file'],
    requiresModel: false,
  },
  runtime: {
    modes: ['poll'],
    defaultIntervalSec: 60,
    minIntervalSec: 30,
    concurrency: 1,
    timeoutMs: 15_000,
    quotas: { maxEventsPerCheck: 200, maxBytesPerCheck: 8 * 1024 * 1024 },
  },
  reliability: {
    checkpoint: 'snapshot',
    replay: { kind: 'none' },
    changeCoverage: 'snapshot-diff',
    gapDetection: 'explicit',
    readOriginal: true,
  },
  defaults: {
    intervalSec: 60,
    maxFiles: 50,
    timeZone: 'Asia/Shanghai',
    lookaheadDays: 30,
    freshnessThresholdSec: 600,
  },
}

/** Validated instance configuration. */
interface CalendarConfig {
  readonly directory: string | null
  readonly file: string | null
  readonly intervalSec: number
  readonly maxFiles: number
  readonly timeZone: string
  readonly lookaheadDays: number
}

/** One parsed VEVENT. */
interface CalendarEvent {
  readonly uid: string
  readonly summary: string
  readonly start: number | null
  readonly end: number | null
  readonly allDay: boolean
  readonly location: string | null
  readonly organizer: string | null
  readonly status: string | null
  readonly description: string | null
  readonly revision: string
}

/** Persisted snapshot state (opaque to the Host). */
interface SnapshotState {
  readonly events: Record<string, string>
}

/** Validate the instance configuration. */
export function validateConfig(raw: unknown): { readonly ok: true; readonly value: CalendarConfig } | { readonly ok: false; readonly message: string } {
  if (typeof raw !== 'object' || raw === null) return { ok: false, message: '配置必须是对象' }
  const record = raw as Record<string, unknown>
  const directory = typeof record['directory'] === 'string' && record['directory'].trim() !== ''
    ? resolve(expandHome(record['directory'].trim()))
    : null
  const file = typeof record['file'] === 'string' && record['file'].trim() !== ''
    ? resolve(expandHome(record['file'].trim()))
    : null
  if (directory === null && file === null) return { ok: false, message: '需要配置 directory 或 file' }
  if (directory !== null && file !== null) return { ok: false, message: 'directory 与 file 只能二选一' }
  const intervalSec = numberOr(record['intervalSec'], 60)
  if (intervalSec < 30) return { ok: false, message: 'intervalSec 不能小于 30' }
  const maxFiles = numberOr(record['maxFiles'], 50)
  if (maxFiles < 1 || maxFiles > 500) return { ok: false, message: 'maxFiles 必须在 1-500 之间' }
  const lookaheadDays = numberOr(record['lookaheadDays'], 30)
  const timeZone = typeof record['timeZone'] === 'string' && record['timeZone'].trim() !== ''
    ? record['timeZone'].trim()
    : 'Asia/Shanghai'
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone }).format(new Date())
  } catch {
    return { ok: false, message: `未知时区：${timeZone}` }
  }
  return { ok: true, value: { directory, file, intervalSec, maxFiles, timeZone, lookaheadDays } }
}

/** The Sense factory. */
export const factory: SenseFactory<CalendarConfig> = {
  validateConfig,
  async probe(config) {
    const path = config.directory ?? config.file
    if (path === null) return { ok: false, detail: '未配置路径' }
    if (!existsSync(path)) return { ok: false, detail: `路径不存在：${path}` }
    return { ok: true }
  },
  start(runtime) {
    return startPolling(runtime)
  },
}

/** Poll loop (timer-driven, abortable, idempotent stop). */
function startPolling(runtime: SenseRuntime<CalendarConfig>): SenseHandle {
  const config = runtime.config
  let revision = runtime.checkpoint.revision
  let state = parseState(runtime.checkpoint.value)
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  let consecutiveFailures = 0

  const schedule = (delayMs: number): void => {
    if (stopped) return
    timer = setTimeout(() => { void check() }, delayMs)
    if (typeof timer === 'object' && 'unref' in timer) timer.unref()
  }

  const check = async (): Promise<void> => {
    if (stopped || runtime.signal.aborted) return
    const startedAt = Date.now()
    try {
      const { events, gaps, files } = readCalendar(config)
      const next = new Map<string, CalendarEvent>()
      for (const event of events) next.set(event.uid, event)
      const envelopes: EventEnvelope[] = []
      for (const event of events) {
        const previous = state.events[event.uid]
        if (previous === event.revision) continue
        envelopes.push(toEnvelope(event, previous === undefined ? 'created' : 'updated'))
      }
      for (const uid of Object.keys(state.events)) {
        if (next.has(uid)) continue
        envelopes.push(removalEnvelope(uid, state.events[uid] ?? 'unknown'))
      }
      const nextState: SnapshotState = {
        events: Object.fromEntries([...next.entries()].map(([uid, event]) => [uid, event.revision])),
      }
      if (envelopes.length > 0) {
        const ack = await runtime.ingress.ingestBatch({
          batchKey: `calendar-${String(startedAt)}-${Math.random().toString(36).slice(2, 8)}`,
          events: envelopes.slice(0, runtime.limits.maxEventsPerCheck),
          checkpointAfter: { value: JSON.stringify(nextState), revision },
          complete: envelopes.length <= runtime.limits.maxEventsPerCheck,
          gap: gaps.length === 0 ? null : { reason: gaps.join('；') },
        })
        revision = ack.checkpointRevision
        state = nextState
      }
      consecutiveFailures = 0
      await runtime.ingress.reportHealth({
        state: gaps.length === 0 ? 'healthy' : 'degraded',
        ...(gaps.length === 0 ? {} : { detail: gaps.join('；') }),
        lastAttemptAt: startedAt,
        lastSuccessfulSyncAt: Date.now(),
        ...(envelopes.length > 0 ? { lastEventAt: Date.now() } : {}),
        consecutiveFailures: 0,
        errorCode: null,
        nextRetryAt: null,
        coveredThrough: `${String(files)} file(s)`,
      })
    } catch (error) {
      consecutiveFailures += 1
      const classified = classify(error)
      await runtime.ingress.reportHealth({
        state: classified.state,
        detail: (error as Error).message,
        lastAttemptAt: startedAt,
        consecutiveFailures,
        errorCode: classified.code,
        nextRetryAt: Date.now() + Math.min(30 * 60_000, 5_000 * 2 ** consecutiveFailures),
      }).catch(() => {})
    } finally {
      schedule(config.intervalSec * 1000)
    }
  }

  void check()
  return {
    stop() {
      stopped = true
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
    },
  }
}

function classify(error: unknown): { readonly state: 'unavailable' | 'auth-required' | 'degraded'; readonly code: string } {
  const code = (error as NodeJS.ErrnoException).code
  if (code === 'EACCES' || code === 'EPERM') return { state: 'auth-required', code: 'permission-denied' }
  if (code === 'ENOENT') return { state: 'unavailable', code: 'path-missing' }
  return { state: 'degraded', code: 'read-failed' }
}

/** Read and parse every configured calendar file. */
export function readCalendar(config: CalendarConfig): {
  readonly events: CalendarEvent[]
  readonly gaps: string[]
  readonly files: number
} {
  const gaps: string[] = []
  const files: string[] = []
  if (config.file !== null) {
    files.push(config.file)
  } else if (config.directory !== null) {
    if (!existsSync(config.directory)) {
      throw Object.assign(new Error(`日历目录不存在：${config.directory}`), { code: 'ENOENT' })
    }
    const entries = readdirSync(config.directory).filter(entry => entry.toLowerCase().endsWith('.ics')).sort()
    if (entries.length > config.maxFiles) {
      gaps.push(`日历文件数 ${String(entries.length)} 超过上限 ${String(config.maxFiles)}，未处理其余文件`)
    }
    for (const entry of entries.slice(0, config.maxFiles)) files.push(join(config.directory, entry))
  } else {
    throw new Error('未配置日历路径')
  }
  const byUid = new Map<string, CalendarEvent>()
  const cutoff = Date.now() - 24 * 60 * 60_000
  const horizon = Date.now() + config.lookaheadDays * 24 * 60 * 60_000
  for (const file of files) {
    let text: string
    try {
      const stat = statSync(file)
      if (!stat.isFile()) continue
      text = readFileSync(file, 'utf8')
    } catch (error) {
      gaps.push(`读取 ${file} 失败：${(error as Error).message}`)
      continue
    }
    for (const event of parseIcs(text, config.timeZone)) {
      if (event.start !== null && (event.start < cutoff || event.start > horizon)) continue
      const existing = byUid.get(event.uid)
      if (existing === undefined || revisionRank(event) > revisionRank(existing)) byUid.set(event.uid, event)
    }
  }
  return {
    events: [...byUid.values()].sort((left, right) => (left.start ?? 0) - (right.start ?? 0)),
    gaps,
    files: files.length,
  }
}

function revisionRank(event: CalendarEvent): number {
  const parsed = Number.parseInt(event.revision.split(':')[0] ?? '0', 10)
  return Number.isFinite(parsed) ? parsed : 0
}

function toEnvelope(event: CalendarEvent, change: 'created' | 'updated'): EventEnvelope {
  const when = event.start === null ? '时间未知' : new Date(event.start).toISOString()
  return {
    eventKey: `${event.uid}:${event.revision}`,
    type: 'calendar/event-updated',
    subject: { key: event.uid, revision: event.revision, label: event.summary },
    operation: 'upsert',
    occurredAt: event.start === null ? null : new Date(event.start).toISOString(),
    observedAt: new Date().toISOString(),
    summary: `日历「${event.summary}」${change === 'created' ? '新增' : '改期'}：${when}`,
    data: {
      uid: event.uid,
      title: event.summary,
      start: event.start === null ? null : new Date(event.start).toISOString(),
      end: event.end === null ? null : new Date(event.end).toISOString(),
      allDay: event.allDay,
      location: event.location,
      organizer: event.organizer,
      status: event.status,
      description: event.description === null ? null : event.description.slice(0, 4000),
      change,
    },
    priority: 'p2',
    deadline: event.start === null ? null : new Date(event.start).toISOString(),
    provenance: { kind: 'observed', collector: 'dsh-quno-sense-calendar' },
    correlationKeys: [`calendar:${event.uid}`],
  }
}

function removalEnvelope(uid: string, previousRevision: string): EventEnvelope {
  return {
    eventKey: `${uid}:removed:${previousRevision}`,
    type: 'calendar/event-cancelled',
    subject: { key: uid, revision: `removed-${previousRevision}` },
    operation: 'retract',
    occurredAt: null,
    observedAt: new Date().toISOString(),
    summary: '日历事件已删除或取消',
    data: { uid, previousRevision },
    priority: 'p2',
    provenance: { kind: 'observed', collector: 'dsh-quno-sense-calendar' },
    correlationKeys: [`calendar:${uid}`],
  }
}

function parseState(value: string | null): SnapshotState {
  if (value === null) return { events: {} }
  try {
    const parsed = JSON.parse(value) as { events?: Record<string, string> }
    return { events: parsed.events ?? {} }
  } catch {
    return { events: {} }
  }
}

/** Parse one iCalendar document into VEVENTs (best-effort, bounded). */
export function parseIcs(text: string, floatingZone: string): CalendarEvent[] {
  const unfolded = text.replace(/\r?\n[ \t]/g, '')
  const lines = unfolded.split(/\r?\n/)
  const events: CalendarEvent[] = []
  let current: Record<string, { value: string; params: Record<string, string> }> | undefined
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.toUpperCase() === 'BEGIN:VEVENT') {
      current = {}
      continue
    }
    if (trimmed.toUpperCase() === 'END:VEVENT') {
      if (current !== undefined) {
        const event = toEvent(current, floatingZone)
        if (event !== null) events.push(event)
      }
      current = undefined
      continue
    }
    if (current === undefined) continue
    const property = parseProperty(trimmed)
    if (property === null) continue
    current[property.name] = { value: property.value, params: property.params }
  }
  return events
}

function parseProperty(line: string): { name: string; value: string; params: Record<string, string> } | null {
  const colon = findValueColon(line)
  if (colon < 0) return null
  const head = line.slice(0, colon)
  const value = line.slice(colon + 1)
  const segments = splitParams(head)
  const property = (segments.shift() ?? '').toUpperCase()
  if (property === '') return null
  const params: Record<string, string> = {}
  for (const segment of segments) {
    const equals = segment.indexOf('=')
    if (equals < 0) continue
    params[segment.slice(0, equals).toUpperCase()] = segment.slice(equals + 1).replace(/^"|"$/g, '')
  }
  return { name: property, value, params }
}

/** The value separator is the first colon outside quoted parameter text. */
function findValueColon(line: string): number {
  let quoted = false
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (char === '"') quoted = !quoted
    else if (char === ':' && !quoted) return index
  }
  return -1
}

function splitParams(head: string): string[] {
  const out: string[] = []
  let current = ''
  let quoted = false
  for (const char of head) {
    if (char === '"') quoted = !quoted
    if (char === ';' && !quoted) {
      out.push(current)
      current = ''
      continue
    }
    current += char
  }
  out.push(current)
  return out
}

function toEvent(
  properties: Record<string, { value: string; params: Record<string, string> }>,
  floatingZone: string,
): CalendarEvent | null {
  const uid = properties['UID']?.value.trim()
  if (uid === undefined || uid === '') return null
  const summary = unescapeText(properties['SUMMARY']?.value ?? '(无标题)')
  const startProperty = properties['DTSTART']
  const start = startProperty === undefined ? null : parseIcsDate(startProperty.value, startProperty.params['TZID'], floatingZone)
  const endProperty = properties['DTEND']
  let end = endProperty === undefined ? null : parseIcsDate(endProperty.value, endProperty.params['TZID'], floatingZone)
  if (end === null && start !== null) {
    const duration = properties['DURATION']?.value
    end = start + (duration === undefined ? 60 * 60_000 : parseDuration(duration))
  }
  const allDay = startProperty !== undefined && /^\d{8}$/.test(startProperty.value)
  const sequence = properties['SEQUENCE']?.value ?? '0'
  const modified = properties['LAST-MODIFIED']?.value ?? properties['DTSTAMP']?.value ?? ''
  const revision = `${sequence}:${modified}:${hash(`${summary}:${String(start)}:${String(end)}:${properties['STATUS']?.value ?? ''}`)}`
  return {
    uid,
    summary,
    start,
    end,
    allDay,
    location: properties['LOCATION'] === undefined ? null : unescapeText(properties['LOCATION'].value),
    organizer: properties['ORGANIZER'] === undefined ? null : unescapeText(properties['ORGANIZER'].value),
    status: properties['STATUS']?.value ?? null,
    description: properties['DESCRIPTION'] === undefined ? null : unescapeText(properties['DESCRIPTION'].value),
    revision,
  }
}

function parseIcsDate(value: string, timeZoneId: string | undefined, floatingZone: string): number | null {
  const dateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(value)
  if (dateOnly !== null) {
    return Date.UTC(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]))
  }
  const utc = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value)
  if (utc !== null) {
    return Date.UTC(Number(utc[1]), Number(utc[2]) - 1, Number(utc[3]), Number(utc[4]), Number(utc[5]), Number(utc[6]))
  }
  const local = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/.exec(value)
  if (local !== null) {
    return zonedWallToEpoch({
      year: Number(local[1]), month: Number(local[2]), day: Number(local[3]),
      hour: Number(local[4]), minute: Number(local[5]), second: Number(local[6]),
    }, timeZoneId ?? floatingZone)
  }
  return null
}

function parseDuration(value: string): number {
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/.exec(value.trim())
  if (match === null) return 60 * 60_000
  const days = Number(match[1] ?? 0)
  const hours = Number(match[2] ?? 0)
  const minutes = Number(match[3] ?? 0)
  return ((days * 24 + hours) * 60 + minutes) * 60_000
}

const FORMATTERS = new Map<string, Intl.DateTimeFormat>()

function zoneOffsetMs(epochMs: number, timeZone: string): number {
  let formatter = FORMATTERS.get(timeZone)
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    })
    FORMATTERS.set(timeZone, formatter)
  }
  const parts = formatter.formatToParts(new Date(epochMs))
  const pick = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find(part => part.type === type)?.value ?? '0')
  const asUtc = Date.UTC(pick('year'), pick('month') - 1, pick('day'), pick('hour'), pick('minute'))
  return asUtc - Math.floor(epochMs / 60_000) * 60_000
}

function zonedWallToEpoch(
  wall: { year: number; month: number; day: number; hour: number; minute: number; second: number },
  timeZone: string,
): number {
  const guess = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second)
  const first = guess - zoneOffsetMs(guess, timeZone)
  const second = guess - zoneOffsetMs(first, timeZone)
  return second
}

function unescapeText(value: string): string {
  return value
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\')
    .trim()
    .slice(0, 4000)
}

function hash(value: string): string {
  let result = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index)
    result = Math.imul(result, 16777619)
  }
  return (result >>> 0).toString(16)
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback
}

function expandHome(path: string): string {
  if (!path.startsWith('~')) return path
  const home = process.env['HOME'] ?? process.env['USERPROFILE'] ?? ''
  return `${home}${path.slice(1)}`
}

/** Register the Sense while the plugin is mounted. */
export function apply(ctx: Context): void {
  const registry = ctx.get('qunoSenses') as unknown as SenseRegistryFace | undefined
  if (registry === undefined) throw new Error('dsh-quno-sense-calendar: qunoSenses service is not mounted')
  ctx.effect(() => registry.register(definition, factory), 'dsh-quno-sense-calendar: registration')
}

export default { name, inject, apply, definition, factory }
