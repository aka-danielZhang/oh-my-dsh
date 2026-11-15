/**
 * Redacted tool cards for the Quno-owned Worker tools (design v2 §6.2: the
 * inspect view keeps PUBLIC tool data only — system prompts, credentials,
 * environment values and private reasoning never surface; §9.4).
 *
 * The stock transcript renders a tool call's raw arguments, and a model can
 * hallucinate undeclared credential parameters (`token: …`) or echo secrets
 * in free text — so the plugin-owned tools (`quno_cli_call`,
 * `quno_exchange`) get keyed toolview cards that shadow the stock card and
 * render the redacted, bounded projection only:
 * `capability.operation` + denylist-redacted arguments + a bounded, scrubbed
 * result summary. The same rules back the v1 timeline (redaction.ts) — one
 * redaction law, two surfaces.
 *
 * @module dsh-quno/client/tool-cards
 */

import React from 'react'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import { ARGS_CLIP, RESULT_CLIP, parseArgs, redact, redactedTextSummary, scrubText } from '../redaction.ts'
import type { QunoTranslate } from './locales.ts'
import { QunoCard } from './ui.tsx'

/** Injected face of the tool cards. */
export interface QunoToolCardInjected {
  readonly t: QunoTranslate
}

type ToolCardProps = ToolCallViewProps & QunoToolCardInjected

/** Bounded result text from the result node's content blocks (text only). */
function resultText(content: unknown): { readonly text: string; readonly clipped: boolean } {
  const raw = Array.isArray(content)
    ? content.flatMap((block) => {
      if (typeof block !== 'object' || block === null) return []
      const record = block as Record<string, unknown>
      return record['type'] === 'text' && typeof record['text'] === 'string' ? [record['text']] : []
    }).join('\n').trim()
    : ''
  const scrubbed = scrubText(raw)
  return { text: redactedTextSummary(scrubbed, RESULT_CLIP), clipped: scrubbed.length > RESULT_CLIP }
}

/** The `capability.operation` head of one parsed CLI call, or a fallback. */
function cliHead(parsed: unknown): string {
  if (typeof parsed === 'object' && parsed !== null) {
    const record = parsed as Record<string, unknown>
    if (typeof record['capability'] === 'string' && typeof record['operation'] === 'string') {
      return `${record['capability']}.${record['operation']}`
    }
  }
  return 'quno_cli_call'
}

/** Shared card body: redacted argument summary, bounded. */
function argsSummaryOf(argsRaw: string | null | undefined): string | null {
  const parsed = parseArgs(argsRaw)
  if (parsed === null) return null
  return JSON.stringify(redact(parsed) ?? {})
}

/** Render one quno_cli_call card (start or result phase). */
export function QunoCliCallCard(props: ToolCardProps): React.ReactElement | null {
  const block = props.block
  const argsRaw = 'phase' in block && block.phase === 'start'
    ? block.argsRaw
    : 'kind' in block && block.kind === 'tool-result'
      ? block.call?.argsRaw
      : undefined
  const args = argsSummaryOf(argsRaw)
  const truncated = args !== null && args.length > ARGS_CLIP
  const shown = args === null ? null : `${args.slice(0, ARGS_CLIP)}${truncated ? '…' : ''}`
  if ('phase' in block && block.phase === 'preparing') return null
  const isResult = 'kind' in block && block.kind === 'tool-result'
  const result = isResult ? resultText((block as { readonly content: unknown }).content) : null
  const isError = isResult ? (block as { readonly isError: boolean }).isError : false
  return (
    <QunoCard accent="var(--dsw-alias-brand-primary)" style={{ marginTop: 6 }}>
      <div className="dsh-quno-card__hd">
        <span className="dsh-quno-card__label">{props.t('toolCardCli')}</span>
        <span className="dsh-quno-card__title" style={{ fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }}>
          {cliHead(parseArgs(argsRaw))}
        </span>
        <span className="dsh-quno-card__meta">
          {isResult
            ? <span style={{ color: isError ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-state-success-primary)' }}>
              {isError ? props.t('toolCardFailed') : props.t('toolCardDone')}
            </span>
            : <span>{props.t('toolCardBusy')}</span>}
        </span>
      </div>
      {shown !== null && (
        <p className="dsh-quno-card__body dsh-quno-tool-card__args">
          <span className="dsh-quno-card__label">{props.t('toolCardParams')}</span>
          <code className="dsh-quno-tool-card__value">{shown}</code>
        </p>
      )}
      {result !== null && result.text !== '' && (
        <p className="dsh-quno-card__body dsh-quno-tool-card__args">
          <span className="dsh-quno-card__label">{props.t('panelTaskResult')}</span>
          <code className="dsh-quno-tool-card__value">
            {result.text}{result.clipped ? '…' : ''}
          </code>
        </p>
      )}
    </QunoCard>
  )
}

/** Render one quno_exchange card (start or result phase). */
export function QunoExchangeCard(props: ToolCardProps): React.ReactElement | null {
  const block = props.block
  const argsRaw = 'phase' in block && block.phase === 'start'
    ? block.argsRaw
    : 'kind' in block && block.kind === 'tool-result'
      ? block.call?.argsRaw
      : undefined
  const parsed = parseArgs(argsRaw)
  const responder = typeof parsed === 'object' && parsed !== null
    && typeof (parsed as Record<string, unknown>)['responder'] === 'string'
    ? (parsed as Record<string, unknown>)['responder'] as string
    : null
  if ('phase' in block && block.phase === 'preparing') return null
  const isResult = 'kind' in block && block.kind === 'tool-result'
  const result = isResult ? resultText((block as { readonly content: unknown }).content) : null
  const isError = isResult ? (block as { readonly isError: boolean }).isError : false
  return (
    <QunoCard accent="var(--dsw-alias-brand-primary)" style={{ marginTop: 6 }}>
      <div className="dsh-quno-card__hd">
        <span className="dsh-quno-card__label">{props.t('toolCardExchange')}</span>
        <span className="dsh-quno-card__title" style={{ fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }}>
          {responder ?? 'quno_exchange'}
        </span>
        <span className="dsh-quno-card__meta">
          {isResult
            ? <span style={{ color: isError ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-state-success-primary)' }}>
              {isError ? props.t('toolCardFailed') : props.t('toolCardDone')}
            </span>
            : <span>{props.t('toolCardBusy')}</span>}
        </span>
      </div>
      {result !== null && result.text !== '' && (
        <p className="dsh-quno-card__body dsh-quno-tool-card__args">
          <span className="dsh-quno-card__label">{props.t('panelTaskResult')}</span>
          <code className="dsh-quno-tool-card__value">{result.text}{result.clipped ? '…' : ''}</code>
        </p>
      )}
    </QunoCard>
  )
}
