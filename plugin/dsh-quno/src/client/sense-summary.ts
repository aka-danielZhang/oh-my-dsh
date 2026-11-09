/**
 * Declaration-driven summaries of a Sense instance's configuration.
 *
 * The rules never invent a field: they read the type's own `configFields`, so
 * a calendar shows its directory, a feed shows its URL and a group-chat source
 * shows how many groups are selected. Secrets never enter a summary.
 *
 * @module dsh-quno/client/sense-summary
 */

import type { SenseFieldWire } from '../api-types.ts'
import type { QunoTranslate } from './locales.ts'
import { format } from './locales.ts'
import { clip } from './format.ts'

/** Whether a config value counts as configured (empty string does not). */
export function isConfigured(value: unknown): boolean {
  if (value === undefined || value === null) return false
  if (typeof value === 'string') return value !== ''
  if (Array.isArray(value)) return value.length > 0
  return true
}

/** A one-line summary derived from declarations only. */
export type SourceSummary =
  | { readonly kind: 'value'; readonly label: string; readonly value: unknown }
  | { readonly kind: 'list'; readonly label: string; readonly count: number }
  | { readonly kind: 'none' }

/**
 * Summarise one instance's configuration:
 * 1. the first configured `path`/`url` field (the most identifying value);
 * 2. else the first configured `multiple` field, reported as a count;
 * 3. else nothing, and the caller shows the type name.
 * @param config - the masked wire config.
 * @param fields - the type's declared fields.
 * @returns the summary discriminator.
 */
export function sourceSummary(
  config: Record<string, unknown>,
  fields: readonly SenseFieldWire[],
): SourceSummary {
  for (const field of fields) {
    if (field.type !== 'path' && field.type !== 'url') continue
    if (field.secret === true) continue
    const value = config[field.key]
    if (!isConfigured(value)) continue
    return { kind: 'value', label: field.label, value }
  }
  for (const field of fields) {
    if (field.multiple !== true || field.secret === true) continue
    const value = config[field.key]
    if (!Array.isArray(value) || value.length === 0) continue
    return { kind: 'list', label: field.label, count: value.length }
  }
  return { kind: 'none' }
}

/**
 * Render a summary for display: a configured path/url, a selected count, or
 * the type's own name. Never a secret, never a guessed field.
 * @param summary - the derived summary.
 * @param fallback - the type's display name.
 * @param t - the translator.
 * @returns one line of text.
 */
export function sourceSummaryText(summary: SourceSummary, fallback: string, t: QunoTranslate): string {
  switch (summary.kind) {
    case 'value': return `${summary.label}：${clip(String(summary.value), 80)}`
    case 'list': return `${summary.label}：${format(t('sourceSummaryCount'), { count: summary.count })}`
    case 'none': return fallback
  }
}
