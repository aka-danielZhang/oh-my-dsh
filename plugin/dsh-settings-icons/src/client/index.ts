/**
 * dsh-settings-icons, browser half.
 *
 * The stock settings shell maps a nav glyph by section id and falls back to
 * one generic gear for every other section, so 使用统计, MCP 和 记忆 all render
 * the same mark. This package decorates those three rows with their own
 * outline glyphs, and nothing else: no slot is punched, no theme token is
 * touched, and unloading restores the stock glyphs.
 *
 * The rows are read from the same `settings.section` ledger the shell projects
 * its nav from, so a section that is not installed is never matched and a
 * locale change (which re-registers the labels) re-matches by itself.
 *
 * @module dsh-settings-icons/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: the client timer service (`ctx.timer`) and its Context merge.
import type {} from '@deepseek-ai/cordis-plugin-timer'
// Type-only: `ctx.slots` (the renderer-owned slot registry face) and the
// 'settings.section' declaration this package reads its rows from.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { NAV_ICON_TARGETS } from './icons.ts'
import { projectRows, startInjection } from './inject.ts'
import type { NavRow } from './inject.ts'

/** The slot key the settings shell projects its nav rows from. */
const SETTINGS_SECTION = 'settings.section'

/**
 * Rescan coalescing delay. The observer fires once per mutation batch, and
 * opening the panel (or any unrelated repaint on a busy page) arrives as a
 * burst; a short delay collapses each burst into one scan.
 */
const SCAN_DELAY_MS = 60

/** Services: the slot ledger, and the timer that coalesces rescans. */
export const inject = ['slots', 'timer']

/**
 * Client plugin body: paint the target settings-nav rows and undo the paint
 * with this fiber.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  // The shell's own projection (ui-settings-general): rows are re-read only
  // when the ledger version moves, and that version also moves when a
  // registrant re-registers on locale change — so labels stay live without
  // re-reading them on every scan.
  let rowsVersion = -1
  let rows: readonly NavRow[] = []
  const readRows = (): readonly NavRow[] => {
    const version = ctx.slots.getVersion(SETTINGS_SECTION)
    if (version !== rowsVersion) {
      rowsVersion = version
      rows = projectRows(ctx.slots.entries(SETTINGS_SECTION).map(entry => entry.options))
    }
    return rows
  }

  ctx.effect(() => startInjection({
    rows: readRows,
    defer: fn => ctx.timer.timeout(fn, SCAN_DELAY_MS),
  }, NAV_ICON_TARGETS), 'dsh-settings-icons: settings-nav glyphs')
}
