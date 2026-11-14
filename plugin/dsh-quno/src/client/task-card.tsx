/**
 * The inline `quno_task` tool view — rendered EMPTY by design v2 (§4.1: the
 * main message flow carries no task cards; §9.5: the main-session tool view
 * returns null). The keyed registration stays: it SHADOWS the stock tool
 * card for `quno_task` calls, so no raw tool meta leaks into the message
 * flow, while the recorded原文 stays untouched in the session log (v2 §1:
 * 历史工具卡可隐藏但原文保留). The work list reads the same facts through the
 * polled projection instead of tool meta.
 *
 * @module dsh-quno/client/task-card
 */

import React from 'react'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import type { QunoLocaleKey } from './locales.ts'
import type { QunoClientStore } from './store.ts'

/** Injected face of the (empty) task tool view. */
export interface QunoTaskCardInjected {
  readonly store: QunoClientStore
  readonly t: (key: QunoLocaleKey) => string
  /** Legacy hand-off (panel → worker session); unused since the card went dark. */
  readonly openPanel: ((taskId?: string) => void) | undefined
}

/** Render nothing: the main flow shows no task cards (design v2 §4.1). */
export function QunoTaskCard(_props: ToolCallViewProps & QunoTaskCardInjected): React.ReactElement | null {
  void React
  return null
}
