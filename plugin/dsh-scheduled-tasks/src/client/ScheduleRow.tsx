/**
 * The schedule row: kind picker, day-of-week/day-of-month pickers, the two
 * column time wheel, and the trailing summary.
 *
 * The kind/day/minute inputs are the plugin's form-field select (34px, r8,
 * hairline l1) because they sit on the form surface rather than inside the
 * composer capsule; the time wheel is the same dropdown card as every other
 * menu (r20, `--dsw-specific-menu`, `--dsw-elevation-prominent`) with two equal
 * columns, hidden scrollbars, and the current value scrolled to the middle when
 * it opens.
 * @module dsh-scheduled-tasks/client/ScheduleRow
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ScheduledTasksLocaleKey } from './locales.ts'

export type Translate = (key: ScheduledTasksLocaleKey, params?: Record<string, string | number>) => string

/** The kind-specific half both the wire spec and a persisted schedule carry. */
export type ScheduleShape =
  | { kind: 'hourly', minute: number }
  | { kind: 'daily', localTime: string }
  | { kind: 'weekdays', localTime: string }
  | { kind: 'weekly', dayOfWeek: number, localTime: string }
  | { kind: 'monthly', dayOfMonth: number, localTime: string }

/** One selectable row of the field select. */
interface Option {
  value: string
  label: string
}

/** Localized one-line description of a schedule. */
export function scheduleText(schedule: ScheduleShape, t: Translate): string {
  const time = schedule.kind === 'hourly' ? '' : schedule.localTime
  if (schedule.kind === 'hourly') {
    return t('schedule.hourly', { minute: String(schedule.minute).padStart(2, '0') })
  }
  if (schedule.kind === 'daily') return t('schedule.daily', { time })
  if (schedule.kind === 'weekdays') return t('schedule.weekdays', { time })
  if (schedule.kind === 'weekly') {
    return t('schedule.weekly', { day: t(`weekday.${String(schedule.dayOfWeek)}` as ScheduledTasksLocaleKey), time })
  }
  return t('schedule.monthly', { day: schedule.dayOfMonth, time })
}

/** The wall time of a schedule as `HH:mm` (hourly rules have none). */
export function scheduleTime(schedule: ScheduleShape): string {
  return schedule.kind === 'hourly' ? '00:00' : schedule.localTime
}

/** Rebuild a form spec from a persisted schedule (kind and fields verbatim). */
export function specOf(schedule: ScheduleShape): ScheduleShape {
  if (schedule.kind === 'hourly') return { kind: 'hourly', minute: schedule.minute }
  if (schedule.kind === 'daily') return { kind: 'daily', localTime: schedule.localTime }
  if (schedule.kind === 'weekdays') return { kind: 'weekdays', localTime: schedule.localTime }
  if (schedule.kind === 'weekly') return { kind: 'weekly', dayOfWeek: schedule.dayOfWeek, localTime: schedule.localTime }
  return { kind: 'monthly', dayOfMonth: schedule.dayOfMonth, localTime: schedule.localTime }
}

/** A spec with every field of its kind present (switching kinds keeps the time). */
export function retargetKind(spec: ScheduleShape, kind: ScheduleShape['kind']): ScheduleShape {
  if (kind === 'hourly') return { kind, minute: Number(scheduleTime(spec).slice(3, 5)) }
  const localTime = scheduleTime(spec)
  if (kind === 'daily' || kind === 'weekdays') return { kind, localTime }
  if (kind === 'weekly') return { kind, dayOfWeek: spec.kind === 'weekly' ? spec.dayOfWeek : 1, localTime }
  return { kind, dayOfMonth: spec.kind === 'monthly' ? spec.dayOfMonth : 1, localTime }
}

const HOURS = Array.from({ length: 24 }, (_, hour) => String(hour).padStart(2, '0'))
const MINUTES = Array.from({ length: 60 }, (_, minute) => String(minute).padStart(2, '0'))

/** Field select: bordered 34px trigger with a 12px caption chevron. */
function FieldSelect({ value, options, width, ariaLabel, onChange }: {
  value: string
  options: readonly Option[]
  width: string
  ariaLabel: string
  onChange: (value: string) => void
}): ReactNode {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!open) return undefined
    const close = (): void => { setOpen(false) }
    document.addEventListener('mousedown', close)
    return () => { document.removeEventListener('mousedown', close) }
  }, [open])
  const current = options.find(option => option.value === value)
  return (
    <div className={`dsh-stask-dd ${width}`}>
      <button
        type="button"
        className={`dsh-stask-field-select${open ? ' dsh-stask-field-select-open' : ''}`}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onMouseDown={event => { event.stopPropagation() }}
        onClick={() => { setOpen(!open) }}
      >
        <span className="dsh-stask-menu-item-label">{current?.label ?? value}</span>
        <span className="dsh-stask-field-caret" aria-hidden="true"><IconChevronDownOutline14 size={12} /></span>
      </button>
      {open
        ? (
          <div className="dsh-stask-field-menu" role="listbox" onMouseDown={event => { event.stopPropagation() }}>
            {options.map(option => (
              <div
                key={option.value}
                role="option"
                aria-selected={option.value === value}
                className={`dsh-stask-field-option${option.value === value ? ' dsh-stask-field-option-active' : ''}`}
                onClick={() => { setOpen(false); onChange(option.value) }}
              >
                {option.label}
              </div>
            ))}
          </div>
        )
        : null}
    </div>
  )
}

/** Two-column time wheel: same width as its trigger, equal columns, no scrollbars. */
function TimePicker({ value, ariaLabel, onChange }: {
  value: string
  ariaLabel: string
  onChange: (value: string) => void
}): ReactNode {
  const [open, setOpen] = useState(false)
  const hourRef = useRef<HTMLDivElement | null>(null)
  const minuteRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!open) return undefined
    const close = (): void => { setOpen(false) }
    document.addEventListener('mousedown', close)
    return () => { document.removeEventListener('mousedown', close) }
  }, [open])
  useLayoutEffect(() => {
    if (!open) return
    for (const column of [hourRef.current, minuteRef.current]) {
      if (column === null) continue
      const active = column.querySelector('.dsh-stask-tp-active')
      if (!(active instanceof HTMLElement)) continue
      column.scrollTop = Math.max(0, active.offsetTop - (column.clientHeight - active.clientHeight) / 2)
    }
  }, [open])
  const [hour, minute] = value.split(':')
  const column = (ref: typeof hourRef, items: readonly string[], current: string | undefined, pick: (item: string) => void): ReactNode => (
    <div className="dsh-stask-tp-col" ref={ref}>
      {items.map(item => (
        <button
          key={item}
          type="button"
          className={`dsh-stask-tp-cell${item === current ? ' dsh-stask-tp-active' : ''}`}
          onClick={() => { pick(item) }}
        >
          {item}
        </button>
      ))}
    </div>
  )
  return (
    <div className="dsh-stask-dd dsh-stask-sched-time">
      <button
        type="button"
        className={`dsh-stask-field-select${open ? ' dsh-stask-field-select-open' : ''}`}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        style={{ justifyContent: 'center' }}
        onMouseDown={event => { event.stopPropagation() }}
        onClick={() => { setOpen(!open) }}
      >
        <span className="dsh-stask-menu-item-label">{value}</span>
      </button>
      {open
        ? (
          <div className="dsh-stask-tp-menu" onMouseDown={event => { event.stopPropagation() }}>
            {column(hourRef, HOURS, hour, item => {
              onChange(`${item}:${minute ?? '00'}`)
            })}
            {column(minuteRef, MINUTES, minute, item => {
              onChange(`${hour ?? '00'}:${item}`)
            })}
          </div>
        )
        : null}
    </div>
  )
}

const KIND_ORDER: readonly ScheduleShape['kind'][] = ['hourly', 'daily', 'weekdays', 'weekly', 'monthly']

/** The schedule row of the editor form. */
export function ScheduleRow({ spec, timeZone, onChange, t }: {
  spec: ScheduleShape
  timeZone: string
  onChange: (next: ScheduleShape) => void
  t: Translate
}): ReactNode {
  const [hour, minute] = scheduleTime(spec).split(':')
  const kindOptions: Option[] = KIND_ORDER.map(kind => ({ value: kind, label: t(`kind.${kind}` as ScheduledTasksLocaleKey) }))
  const weekdayOptions: Option[] = [1, 2, 3, 4, 5, 6, 7].map(day => ({
    value: String(day),
    label: t(`weekday.${String(day)}` as ScheduledTasksLocaleKey),
  }))
  const dayOfMonthOptions: Option[] = Array.from({ length: 31 }, (_, index) => ({
    value: String(index + 1),
    label: `${String(index + 1)}${t('kind.dayOfMonthSuffix')}`,
  }))
  const minuteOptions: Option[] = MINUTES.map(item => ({ value: item, label: item }))
  return (
    <div className="dsh-stask-sched-row">
      <FieldSelect
        value={spec.kind}
        options={kindOptions}
        width="dsh-stask-sched-kind"
        ariaLabel={t('form.schedule')}
        onChange={kind => { onChange(retargetKind(spec, kind as ScheduleShape['kind'])) }}
      />
      {spec.kind === 'hourly'
        ? (
          <>
            <span className="dsh-stask-sched-seg">{t('kind.hourlyPrefix')}</span>
            <FieldSelect
              value={String(spec.minute).padStart(2, '0')}
              options={minuteOptions}
              width="dsh-stask-sched-num"
              ariaLabel={t('kind.hourlySuffix')}
              onChange={value => { onChange({ kind: 'hourly', minute: Number(value) }) }}
            />
            {t('kind.hourlySuffix') === '' ? null : <span className="dsh-stask-sched-seg">{t('kind.hourlySuffix')}</span>}
          </>
        )
        : null}
      {spec.kind === 'weekly'
        ? (
          <FieldSelect
            value={String(spec.dayOfWeek)}
            options={weekdayOptions}
            width="dsh-stask-sched-num"
            ariaLabel={t('kind.weekly')}
            onChange={value => { onChange({ ...spec, dayOfWeek: Number(value) }) }}
          />
        )
        : null}
      {spec.kind === 'monthly'
        ? (
          <FieldSelect
            value={String(spec.dayOfMonth)}
            options={dayOfMonthOptions}
            width="dsh-stask-sched-num"
            ariaLabel={t('kind.monthly')}
            onChange={value => { onChange({ ...spec, dayOfMonth: Number(value) }) }}
          />
        )
        : null}
      {spec.kind === 'daily' || spec.kind === 'weekdays' || spec.kind === 'weekly' || spec.kind === 'monthly'
        ? <span className="dsh-stask-sched-seg">{t('kind.at')}</span>
        : null}
      {spec.kind === 'hourly'
        ? null
        : (
          <TimePicker
            value={`${hour ?? '00'}:${minute ?? '00'}`}
            ariaLabel={t('form.schedule')}
            onChange={value => {
              const [nextHour, nextMinute] = value.split(':')
              const localTime = `${nextHour ?? '00'}:${nextMinute ?? '00'}`
              onChange(spec.kind === 'daily' || spec.kind === 'weekdays'
                ? { kind: spec.kind, localTime }
                : { ...spec, localTime })
            }}
          />
        )}
      <span className="dsh-stask-sched-summary">{`${scheduleText(spec, t)} · ${timeZone}`}</span>
    </div>
  )
}
