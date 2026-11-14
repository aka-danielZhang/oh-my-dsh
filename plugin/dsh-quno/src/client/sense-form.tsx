/**
 * Declaration-driven Sense configuration: turns `SenseConfigField[]` into a
 * real form (numbers with bounds, booleans, static choices, string lists, and
 * remotely discovered options) instead of asking the user to write JSON.
 *
 * The Host remains the final validator. This form only builds a config object
 * and surfaces the Host's rejection verbatim; it never "fixes" a cross-field
 * rule locally (the calendar's file/directory choice is the canonical case).
 *
 * @module dsh-quno/client/sense-form
 */

import React from 'react'
import { Button, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { QunoLocaleKey } from './locales.ts'
import type { QunoClientStore } from './store.ts'
import type { SenseFieldWire, SenseOptionWire } from '../api-types.ts'
import { format } from './locales.ts'
import { parseJsonObject } from './format.ts'
import { ErrorBanner, Field, Select, TextArea, TextInput } from './ui.tsx'

/** Injected face of the form. */
export interface SenseFormInjected {
  readonly store: QunoClientStore
  readonly t: (key: QunoLocaleKey, params?: Record<string, string | number>) => string
}

/** Build the initial draft from declared defaults (unknown values stay absent). */
export function initialSenseConfig(fields: readonly SenseFieldWire[]): Record<string, unknown> {
  const config: Record<string, unknown> = {}
  for (const field of fields) {
    if (field.defaultValue !== undefined) {
      config[field.key] = field.multiple === true && !Array.isArray(field.defaultValue)
        ? [field.defaultValue]
        : field.defaultValue
      continue
    }
    if (field.type === 'boolean') config[field.key] = false
  }
  return config
}

/** Props of one Sense form body (create and edit share it). */
export interface SenseFormProps extends SenseFormInjected {
  readonly type: string
  readonly fields: readonly SenseFieldWire[]
  readonly config: Record<string, unknown>
  readonly onChange: (next: Record<string, unknown>) => void
  readonly label?: string
  readonly onLabelChange?: (label: string) => void
  readonly disabled?: boolean
}

/** Render the whole configured form (basic fields, advanced group, raw JSON). */
export function SenseForm(props: SenseFormProps): React.ReactElement {
  const { fields, config, onChange, t, disabled } = props
  const [rawMode, setRawMode] = React.useState(fields.length === 0)
  const [rawText, setRawText] = React.useState(() => JSON.stringify(config, null, 2))
  const [rawError, setRawError] = React.useState<string | null>(null)

  // Switching the Sense type re-seeds the raw editor; typing inside one type
  // never fights the incoming props.
  React.useEffect(() => {
    setRawText(JSON.stringify(props.config, null, 2))
    setRawError(null)
  }, [props.type])

  const basic = fields.filter(field => field.advanced !== true)
  const advanced = fields.filter(field => field.advanced === true)
  const update = (key: string, value: unknown): void => {
    onChange({ ...config, [key]: value })
  }
  const removeKey = (key: string): void => {
    const next = { ...config }
    delete next[key]
    onChange(next)
  }

  const toggleRaw = (): void => {
    if (!rawMode) setRawText(JSON.stringify(config, null, 2))
    setRawError(null)
    setRawMode(!rawMode)
  }

  return (
    <div style={styles.stack}>
      {props.onLabelChange !== undefined && (
        <Field label={t('senseLabel')}>
          <TextInput
            value={props.label ?? ''}
            disabled={disabled}
            placeholder={t('onboardingLabel')}
            onChange={event => { props.onLabelChange?.(event.target.value) }}
          />
        </Field>
      )}

      {rawMode
        ? (
          <Field label={t('onboardingRawJson')} hint={t('onboardingRawJsonHint')}>
            <TextArea
              value={rawText}
              disabled={disabled}
              spellCheck={false}
              style={{ minHeight: 180 }}
              onChange={(event) => {
                setRawText(event.target.value)
                const parsed = parseJsonObject(event.target.value)
                if (!parsed.ok) {
                  setRawError(parsed.error)
                  return
                }
                setRawError(null)
                onChange(parsed.value)
              }}
            />
          </Field>
        )
        : (
          <>
            <div style={styles.grid}>
              {basic.map(field => (
                <SenseFieldControl
                  key={field.key}
                  {...props}
                  field={field}
                  value={config[field.key]}
                  disabled={disabled === true}
                  onValue={next => { update(field.key, next) }}
                  onClear={() => { removeKey(field.key) }}
                />
              ))}
            </div>
            {advanced.length > 0 && (
              <details style={styles.details}>
                <summary style={styles.summary}>{t('onboardingOptionalAdvanced')}</summary>
                <div style={styles.grid}>
                  {advanced.map(field => (
                    <SenseFieldControl
                      key={field.key}
                      {...props}
                      field={field}
                      value={config[field.key]}
                      disabled={disabled === true}
                      onValue={next => { update(field.key, next) }}
                      onClear={() => { removeKey(field.key) }}
                    />
                  ))}
                </div>
              </details>
            )}
          </>
        )}

      {rawError !== null && <ErrorBanner>{rawError}</ErrorBanner>}
      <div>
        <Button size="sm" variant="ghost" disabled={disabled} onClick={toggleRaw}>
          {rawMode ? t('onboardingConfigure') : t('onboardingRawJson')}
        </Button>
      </div>
    </div>
  )
}

function SenseFieldControl(props: SenseFormProps & {
  readonly field: SenseFieldWire
  readonly value: unknown
  readonly disabled: boolean
  readonly onValue: (value: unknown) => void
  readonly onClear: () => void
}): React.ReactElement {
  const { field, value, disabled, onValue, t } = props
  const requiredHint = field.required === true ? t('onboardingRequired') : undefined
  const hint = [field.help, requiredHint].filter((part): part is string => part !== undefined && part !== '').join(' · ')

  if (field.discover === true) {
    return (
      <div style={styles.fullWidth}>
        <Field label={field.label} hint={hint}>
          <OptionPicker
            store={props.store}
            t={t}
            type={props.type}
            field={field}
            config={props.config}
            value={value}
            disabled={disabled}
            onChange={onValue}
          />
        </Field>
      </div>
    )
  }

  if (field.type === 'boolean') {
    return (
      <Field label={field.label} hint={hint}>
        <Switch checked={value === true} disabled={disabled} label={field.label} onChange={next => { onValue(next) }} />
      </Field>
    )
  }

  if (field.type === 'number') {
    const numeric = typeof value === 'number' ? value : typeof value === 'string' && value !== '' ? Number(value) : ''
    return (
      <Field label={field.label} hint={hint}>
        <TextInput
          type="number"
          value={Number.isNaN(numeric) ? '' : numeric}
          disabled={disabled}
          min={field.min}
          max={field.max}
          step={field.step}
          onChange={(event) => {
            const text = event.target.value
            onValue(text === '' ? undefined : Number(text))
          }}
        />
      </Field>
    )
  }

  if (field.options !== undefined && field.options.length > 0) {
    return (
      <Field label={field.label} hint={hint}>
        <Select
          value={typeof value === 'string' ? value : ''}
          disabled={disabled}
          onChange={(event) => {
            const next = event.target.value
            onValue(next === '' ? undefined : next)
          }}
        >
          <option value="">—</option>
          {field.options.map(option => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </Select>
      </Field>
    )
  }

  if (field.multiple === true) {
    const list = Array.isArray(value) ? value.map(item => String(item)) : value === undefined || value === '' ? [] : String(value).split(/[\s,，;；]+/)
    return (
      <div style={styles.fullWidth}>
        <Field label={field.label} hint={hint}>
          <TextArea
            value={list.join('\n')}
            disabled={disabled}
            spellCheck={false}
            style={{ minHeight: 60 }}
            placeholder={field.placeholder}
            onChange={(event) => {
              const next = event.target.value.split(/[\s,，;；]+/).map(part => part.trim()).filter(part => part !== '')
              onValue(next)
            }}
          />
        </Field>
      </div>
    )
  }

  if (field.secret === true) {
    return (
      <SecretField
        field={field}
        value={value === null || typeof value === 'string' ? value as string | null : ''}
        hint={hint}
        disabled={disabled}
        onChange={onValue}
        onRemoveKey={props.onClear}
        t={t}
      />
    )
  }

  return (
    <Field label={field.label} hint={hint}>
      <TextInput
        type={field.type === 'url' ? 'url' : 'text'}
        value={typeof value === 'string' ? value : ''}
        disabled={disabled}
        placeholder={field.placeholder}
        onChange={event => { onValue(event.target.value === '' ? undefined : event.target.value) }}
      />
    </Field>
  )
}

/**
 * A secret input with four explicit states instead of a truthiness guess:
 * unset, stored-and-unchanged, about-to-be-replaced, about-to-be-cleared.
 */
function SecretField(props: {
  readonly field: SenseFieldWire
  /** `null` means a value is stored but never sent to the browser. */
  readonly value: string | null
  readonly hint: string | undefined
  readonly disabled: boolean
  readonly onChange: (value: unknown) => void
  /** Remove the key entirely, which the Host reads as "keep what is stored". */
  readonly onRemoveKey: () => void
  readonly t: (key: QunoLocaleKey) => string
}): React.ReactElement {
  const stored = props.value === null
  const [draft, setDraft] = React.useState('')
  const [clearing, setClearing] = React.useState(false)

  // Switching type or instance resets the local draft; a poll never does.
  React.useEffect(() => {
    setDraft('')
    setClearing(false)
  }, [props.field.key])

  const phase: 'unset' | 'keep' | 'replace' | 'clear' = clearing
    ? 'clear'
    : draft !== ''
      ? 'replace'
      : stored ? 'keep' : 'unset'

  return (
    <Field label={props.field.label} hint={props.hint}>
      <div style={styles.inline}>
        <TextInput
          type="password"
          value={draft}
          disabled={props.disabled || clearing}
          placeholder={stored ? '••••••' : props.field.placeholder}
          onChange={(event) => {
            const text = event.target.value
            setDraft(text)
            // Deleting the draft is not an instruction to clear: it restores
            // "keep whatever is stored" (or "unset" while creating).
            if (text === '') props.onRemoveKey()
            else props.onChange(text)
          }}
        />
        {stored && !clearing && (
          <Button
            size="sm"
            variant="ghost"
            disabled={props.disabled}
            onClick={() => { setClearing(true); setDraft(''); props.onChange('') }}
          >
            {props.t('secretClearAction')}
          </Button>
        )}
        {clearing && (
          <Button
            size="sm"
            variant="ghost"
            disabled={props.disabled}
            onClick={() => { setClearing(false); props.onRemoveKey() }}
          >
            {props.t('secretUndoClear')}
          </Button>
        )}
      </div>
      <span style={styles.muted}>{props.t(secretPhaseKey(phase))}</span>
    </Field>
  )
}

function secretPhaseKey(phase: 'unset' | 'keep' | 'replace' | 'clear'): QunoLocaleKey {
  switch (phase) {
    case 'unset': return 'secretStateUnset'
    case 'keep': return 'secretStateKeep'
    case 'replace': return 'secretStateReplace'
    case 'clear': return 'secretStateClear'
  }
}

/**
 * Multi/single choice backed by the Sense's own option discovery. Each request
 * is keyed by type + field + draft config + page; an answer whose key is no
 * longer current is dropped instead of overwriting newer options.
 */
function OptionPicker(props: {
  readonly store: QunoClientStore
  readonly t: (key: QunoLocaleKey, params?: Record<string, string | number>) => string
  readonly type: string
  readonly field: SenseFieldWire
  readonly config: Record<string, unknown>
  readonly value: unknown
  readonly disabled: boolean
  readonly onChange: (value: unknown) => void
}): React.ReactElement {
  const multiple = props.field.multiple === true
  const selected = React.useMemo(() => {
    if (Array.isArray(props.value)) return props.value.map(item => String(item))
    if (typeof props.value === 'string' && props.value !== '') return [props.value]
    return []
  }, [props.value])
  const [open, setOpen] = React.useState(false)
  const [options, setOptions] = React.useState<readonly SenseOptionWire[]>([])
  const [page, setPage] = React.useState(1)
  const [more, setMore] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<{ code: string; message: string } | null>(null)
  const latestRequest = React.useRef('')

  // A different type or field is a different registry: drop the old options.
  React.useEffect(() => {
    setOptions([])
    setOpen(false)
    setError(null)
    setPage(1)
    setMore(false)
    latestRequest.current = ''
  }, [props.type, props.field.key])

  const requestKey = (nextPage: number): string =>
    `${props.type}|${props.field.key}|${String(nextPage)}|${JSON.stringify(props.config)}`

  const load = async (nextPage: number, append: boolean): Promise<void> => {
    const key = requestKey(nextPage)
    latestRequest.current = key
    setBusy(true)
    setError(null)
    try {
      const result = await props.store.listSenseOptions({
        type: props.type,
        field: props.field.key,
        config: props.config,
        page: nextPage,
        limit: 20,
      })
      if (latestRequest.current !== key) return
      if (!result.ok) {
        setError(result.error ?? { code: 'unknown', message: props.t('onboardingOptionsErrorGeneric') })
        return
      }
      setOptions(previous => append ? mergeOptions(previous, result.options) : result.options)
      setMore(result.more)
      setPage(nextPage)
    } catch (reason) {
      if (latestRequest.current !== key) return
      setError({ code: 'request-failed', message: (reason as Error).message })
    } finally {
      if (latestRequest.current === key) setBusy(false)
    }
  }

  const toggle = (value: string): void => {
    if (multiple) {
      const next = selected.includes(value) ? selected.filter(item => item !== value) : [...selected, value]
      props.onChange(next)
      return
    }
    props.onChange(value)
  }
  const remove = (value: string): void => {
    if (multiple) props.onChange(selected.filter(item => item !== value))
    else props.onChange(undefined)
  }

  const known = new Map(options.map(option => [option.value, option]))
  const pickLabel = format(props.t('onboardingOptionsPick'), { label: props.field.label })
  return (
    <div style={styles.stack}>
      <div style={styles.chips}>
        {selected.length === 0 && (
          <span style={styles.muted}>{format(props.t('onboardingOptionsNone'), { label: props.field.label })}</span>
        )}
        {selected.map(value => (
          <span key={value} style={styles.selectedChip}>
            {known.get(value)?.label ?? value}
            <button
              type="button"
              style={styles.chipRemove}
              disabled={props.disabled}
              aria-label={`${props.t('remove')} ${value}`}
              onClick={() => { remove(value) }}
            >
              ×
            </button>
          </span>
        ))}
      </div>
      <div style={styles.inline}>
        <Button
          size="sm"
          variant="outline"
          disabled={props.disabled || busy}
          onClick={() => {
            if (open) {
              setOpen(false)
              return
            }
            setOpen(true)
            if (options.length === 0 || error !== null) void load(1, false)
          }}
        >
          {busy && options.length === 0
            ? props.t('onboardingOptionsLoading')
            : open
              ? props.t('onboardingCollapse')
              : error !== null ? props.t('retry') : pickLabel}
        </Button>
        {multiple && selected.length > 0 && (
          <span style={styles.muted}>{format(props.t('onboardingOptionsSelected'), { count: selected.length })}</span>
        )}
      </div>
      {open && (
        <div style={styles.optionList}>
          {busy && options.length === 0 && <span style={styles.muted}>{props.t('onboardingOptionsLoading')}</span>}
          {!busy && error === null && options.length === 0 && <span style={styles.muted}>{props.t('onboardingOptionsEmpty')}</span>}
          {options.map(option => (
            <label
              key={option.value}
              style={{ ...styles.optionRow, ...(option.disabled === true ? styles.optionDisabled : {}) }}
              title={option.disabledReason}
            >
              <input
                type={multiple ? 'checkbox' : 'radio'}
                name={`quno-option-${props.field.key}`}
                checked={selected.includes(option.value)}
                disabled={props.disabled || option.disabled === true}
                onChange={() => { toggle(option.value) }}
              />
              <span style={styles.optionLabel}>{option.label}</span>
              {option.description !== undefined && <span style={styles.muted}>{option.description}</span>}
              {option.disabled === true && (
                <span style={styles.muted}>{option.disabledReason ?? props.t('onboardingOptionDisabled')}</span>
              )}
            </label>
          ))}
          {more && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => { void load(page + 1, true) }}>
              {props.t('onboardingOptionsMore')}
            </Button>
          )}
          {error !== null && (
            <div style={styles.errorNote}>
              <span>
                {error.code === 'auth-required'
                  ? props.t('onboardingOptionsAuth')
                  : format(props.t('onboardingOptionsError'), { error: error.message })}
              </span>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => { void load(page, true) }}>
                {props.t('retry')}
              </Button>
            </div>
          )}
          <span style={styles.muted}>{props.t('onboardingOptionsAddManual')}</span>
        </div>
      )}
    </div>
  )
}

function mergeOptions(previous: readonly SenseOptionWire[], next: readonly SenseOptionWire[]): readonly SenseOptionWire[] {
  const seen = new Set(previous.map(option => option.value))
  return [...previous, ...next.filter(option => !seen.has(option.value))]
}

const styles = {
  stack: { display: 'flex', flexDirection: 'column', gap: 10 },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 },
  fullWidth: { gridColumn: '1 / -1' },
  details: { display: 'flex', flexDirection: 'column', gap: 10 },
  summary: { cursor: 'pointer', fontSize: 12, color: 'var(--dsw-alias-label-secondary)' },
  inline: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  chips: { display: 'flex', gap: 6, flexWrap: 'wrap', minHeight: 22 },
  selectedChip: {
    display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 6px', borderRadius: 6,
    background: 'var(--dsw-alias-bg-layer-2)', fontSize: 11, color: 'var(--dsw-alias-label-primary)',
    maxWidth: '100%', overflow: 'hidden',
  },
  chipRemove: {
    border: 0, background: 'transparent', cursor: 'pointer', color: 'var(--dsw-alias-label-tertiary)',
    font: 'inherit', padding: 0,
  },
  optionList: {
    display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 240, overflowY: 'auto',
    border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 8, padding: 8,
    background: 'var(--dsw-alias-bg-layer-1)',
  },
  optionRow: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer', flexWrap: 'wrap' },
  optionDisabled: { opacity: 0.6, cursor: 'not-allowed' },
  optionLabel: { color: 'var(--dsw-alias-label-primary)' },
  muted: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' },
  errorNote: { fontSize: 11, color: 'var(--dsw-alias-state-error-primary)', lineHeight: 1.5 },
} as const
