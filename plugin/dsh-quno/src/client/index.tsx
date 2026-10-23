/**
 * Browser entry for Quno: mounts the `quno` Remote namespace, starts the
 * polling snapshot store, and contributes the redesigned surface (design §13):
 *
 * - the `sidebar.workspaces` browsing-region replacement (「Quno / 会话」tabs);
 * - the main-conversation marker + chrome cleanup (`data-quno-main` seams and
 *   the preset-label shadow);
 * - the right-sidebar panel (two-stage registration, ui-schedule precedent)
 *   with the auto-open that swaps the right column inside a Quno main
 *   conversation;
 * - the collapsed-state capsule (`shell.overlay`) and the task-card linkage;
 * - the settings section (always mounted: it owns the master switch).
 *
 * Everything except settings, the task card and the turn-tail actions is
 * gated on the master switch (`config.enabled`): turning it off disposes the
 * gated registrations so the stock WorkspaceBrowser and header chrome return
 * unchanged.
 *
 * @module dsh-quno/client
 */

import React from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { QunoLocaleKey } from './locales.ts'
import type { QunoRemoteFace } from './store.ts'
import type { SidebarRightFace } from './pill.tsx'
import TYPERT_REMOTE from '../typert.remote-client.ts'
import { QunoClientStore } from './store.ts'
import { en, zh } from './locales.ts'
import { QunoSettingsSection } from './settings.tsx'
import { QunoAlternateView } from './alternate.tsx'
import { QunoMainMarker, QunoPresetLabelShadow } from './marker.tsx'
import { QunoPanelTab, QunoPanelTitle } from './panel.tsx'
import { QunoPanelPill } from './pill.tsx'
import { QunoTaskCard } from './task-card.tsx'
import { QunoReportActions } from './report-actions.tsx'
import { surfaceEnabled } from './view-model.ts'
import { QUNO_PANEL_ID, QUNO_PANEL_KIND } from './right-tab.ts'
import { QUNO_CSS } from './ui.tsx'

/** Dictionary namespace owned by this plugin. */
const NS = 'quno'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Quno browser copy. */
    quno: QunoLocaleKey
  }
}

/** Required client services (the two sidebar services are optional: duck-checked). */
export const inject = ['slots', 'locale', 'remote', 'sessions']

/** Structural face of the sessions list store (projection carrier). */
interface SessionsListSnapshot {
  readonly ids: readonly string[]
  readonly byId: Record<string, { readonly projectionValues?: { readonly agentPreset?: string | null } } | undefined>
}

interface SessionsFace {
  readonly list: { getSnapshot(): SessionsListSnapshot; subscribe(fn: () => void): () => void }
}

/** Structural face of the right-sidebar tab type registry. */
interface SidebarRightTabsFace {
  register(definition: {
    readonly id: string
    readonly kind: string
    readonly multiple?: boolean
    readonly keepMounted?: boolean
    readonly title: (address: string) => string
  }): () => void
}

/** Duck-check a candidate against a required method face. */
function hasMethod(value: unknown, method: string): boolean {
  return typeof value === 'object' && value !== null
    && typeof (value as Record<string, unknown>)[method] === 'function'
}

/** Mount Quno's browser surface. */
export async function apply(ctx: ClientContext): Promise<() => Promise<void>> {
  const disposeRemote = ctx.get('remote.quno') === undefined
    ? await ctx.remote.$mount(TYPERT_REMOTE)
    : async (): Promise<void> => {}
  const remote = ctx.get('remote.quno') as QunoRemoteFace | undefined
  if (remote === undefined) {
    await disposeRemote()
    throw new Error('dsh-quno: the quno Remote namespace did not mount')
  }
  const store = new QunoClientStore(remote)
  const sessions = ctx.get('sessions') as SessionsFace | undefined
  const sidebarRight = hasMethod(ctx.get('sidebarRight'), 'openTab')
    ? (ctx.get('sidebarRight') as unknown as SidebarRightFace)
    : undefined
  const sidebarRightTabs = hasMethod(ctx.get('sidebarRightTabs'), 'register')
    ? (ctx.get('sidebarRightTabs') as unknown as SidebarRightTabsFace)
    : undefined
  const openSession = (sessionId: string): void => {
    const workspace = ctx.get('uiWorkspace') as { openSession(sessionId: SessionId): void } | undefined
    workspace?.openSession(sessionId as SessionId)
  }
  // The panel linkage degrades to the child-session jump while the gated
  // surface is disposed or the service is missing (an unregistered kind throws).
  let panelReady = false
  const openPanel = (taskId?: string): void => {
    if (taskId === undefined || !panelReady || sidebarRight === undefined) {
      const child = taskId === undefined
        ? undefined
        : store.getSnapshot().state?.tasks.find(task => task.id === taskId)?.childSessionId
      if (child !== null && child !== undefined) openSession(child)
      return
    }
    sidebarRight.openTab(QUNO_PANEL_KIND, { params: { taskId, view: 'task' } })
  }
  const locale = (): 'zh' | 'en' => ctx.locale.getLocale().active.toLowerCase().startsWith('zh') ? 'zh' : 'en'
  // Registrations held while the master switch is on (see the gated surface
  // below); shared with the catch path so an apply failure unwinds cleanly.
  const held: (() => void)[] = []
  const releaseHeld = (): void => {
    for (const dispose of held.splice(0)) {
      try { dispose() } catch { /* idempotent disposers; a doubled call is fine */ }
    }
    panelReady = false
  }

  try {
    ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-quno: dictionaries')
    const t = ctx.locale.bind(NS) as (key: QunoLocaleKey, params?: Record<string, string | number>) => string

    ctx.effect(() => store.start(), 'dsh-quno: polling')

    // The settings section is Quno's home for configuration AND operational state.
    ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section',
      id: 'quno',
      order: 12,
      label: () => t('nav'),
      inject: () => ({ store, t, openSession, locale }),
    }, QunoSettingsSection))

    // Inline task card for quno_task calls (registered ungated: historic cards
    // stay readable; the panel action degrades through `openPanel`).
    ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
      name: 'tool.call.toolview',
      key: 'quno_task',
      inject: () => ({ store, t, openSession, openPanel }),
    }, QunoTaskCard))

    // Deterministic report actions at the turn tail of the Quno conversation.
    ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
      name: 'conversation.chat.turnTail',
      id: 'quno-report-actions',
      order: 30,
      inject: () => ({ store, t }),
    }, QunoReportActions))

    // Claimed stylesheet (see the 2026-09-08 cross-plugin style incident): a
    // plugin-tagged, dedupe-guarded sheet is never deleted by another plugin's
    // HMR reload.
    ctx.effect(() => {
      const tagId = 'dsh-quno/client-css'
      if (document.querySelector(`style[data-plugin-css="${tagId}"]`) !== null) return () => {}
      const style = document.createElement('style')
      style.dataset.plugin = 'dsh-quno'
      style.dataset.pluginCss = tagId
      style.textContent = QUNO_CSS
      document.head.appendChild(style)
      return () => { style.remove() }
    })

    // ---------------------------------------------------------- gated surface
    // Registered while the master switch is on; disposed (stock UI returns)
    // while it is off. `slots.inject` ties each contribution to this fiber, so
    // a plugin unload cleans up even if the listener never fires again.
    const presetOf = (sessionId: string): string | null | undefined =>
      sessions?.list.getSnapshot().byId[sessionId]?.projectionValues?.agentPreset

    const registerGated = (): void => {
      // Left column: the Quno tab beside the stock browser (§13.2, work/Quno
      // arrangement). The fork's region wrapper renders this seat as the
      // second tab and mounts us only while it is active; disposing it (master
      // switch off) removes the tab and leaves the stock region verbatim.
      held.push(ctx.slots.inject('sidebar.workspaces.alternate', () => ctx.slots.register({
        name: 'sidebar.workspaces.alternate',
        id: 'quno',
        order: 10,
        label: () => t('nav'),
        inject: () => ({ store, t, openSession, openPanel }),
      }, QunoAlternateView)))

      // Right column: two-stage panel registration (§13.4).
      if (sidebarRightTabs !== undefined) {
        held.push(sidebarRightTabs.register({
          id: QUNO_PANEL_ID,
          kind: QUNO_PANEL_KIND,
          multiple: false,
          keepMounted: true,
          title: () => t('nav'),
        }))
        held.push(ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab',
          key: QUNO_PANEL_ID,
          inject: () => ({ store, t, openSession }),
        }, QunoPanelTab)))
        held.push(ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab.title',
          key: QUNO_PANEL_ID,
          inject: () => ({ store, t, openSession }),
        }, QunoPanelTitle)))
        panelReady = true
      }

      // Collapsed-state capsule (§13.5).
      if (sidebarRight !== undefined) {
        held.push(ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'quno-panel-pill',
          order: 40,
          inject: () => ({ store, t, face: sidebarRight }),
        }, QunoPanelPill)))
      }

      // Main-conversation identification + chrome cleanup (§13.3). Two seats
      // carry the same claim: the header utilities render once the conversation
      // is active, while `conversation.hero.options` covers the blank-session
      // hero (first open, header chrome hidden) — the owner-token claim in the
      // marker hands over between them without a flash.
      held.push(ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
        name: 'conversation.session.header.utilities',
        id: 'quno-main-marker',
        order: 50,
      }, QunoMainMarker)))
      held.push(ctx.slots.inject('conversation.hero.options', () => ctx.slots.register({
        name: 'conversation.hero.options',
        id: 'quno-main-marker-hero',
        order: 50,
      }, QunoMainMarker)))
      held.push(ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
        name: 'conversation.session.header.actions',
        id: 'agent-preset',
        priority: -1,
      }, QunoPresetLabelShadow)))

      // Auto-open: entering a Quno main conversation swaps the right column
      // for the Quno panel (§13.4). Once per on-screen session; closing the
      // tab does not re-fire until the session changes. The surface store may
      // not be adopted yet on the first mounted tick — openTab throws then —
      // so a failed attempt retries with a short bounded backoff instead of
      // poisoning the store listener.
      let openedFor: string | null = null
      let retryTimer: ReturnType<typeof setTimeout> | undefined
      const evaluate = (): void => {
        if (sidebarRight === undefined || !panelReady) return
        const mounted = sidebarRight.mounted.getSnapshot()
        if (mounted === undefined || mounted === openedFor) {
          if (mounted === undefined) openedFor = null
          return
        }
        if (presetOf(mounted) !== 'quno') {
          openedFor = null
          return
        }
        try {
          sidebarRight.openTab(QUNO_PANEL_KIND)
          openedFor = mounted
        } catch {
          openedFor = null
          if (retryTimer === undefined) {
            retryTimer = setTimeout(() => {
              retryTimer = undefined
              evaluate()
            }, 600)
          }
        }
      }
      held.push(ctx.effect(() => {
        const disposers = [
          sidebarRight?.mounted.subscribe(evaluate),
          sessions?.list.subscribe(evaluate),
        ]
        evaluate()
        return () => {
          if (retryTimer !== undefined) clearTimeout(retryTimer)
          for (const dispose of disposers) dispose?.()
        }
      }, 'dsh-quno: panel auto-open'))
    }

    const applyGating = (): void => {
      const desired = surfaceEnabled(store.getSnapshot().state)
      // A registration failure (missing seat in a composed runtime without the
      // sidebar, say) must not wedge the gate: log once, keep the gate closed,
      // and let a later evaluate retry after a release.
      try {
        if (desired && held.length === 0) registerGated()
        else if (!desired && held.length > 0) releaseHeld()
      } catch (error) {
        console.error('[dsh-quno] gated registration failed:', error instanceof Error ? error.message : String(error))
      }
    }
    ctx.effect(() => store.subscribe(applyGating), 'dsh-quno: master-switch gating')
    // First evaluation once the initial snapshot is in (the polling store
    // refreshes before the first tick); repeat evaluation is idempotent.
    void store.refresh().then(applyGating).catch(() => {})

    return async () => {
      releaseHeld()
      await disposeRemote()
    }
  } catch (error) {
    releaseHeld()
    await disposeRemote()
    throw error
  }
}

/** Keep React referenced for the JSX runtime in older bundler interop. */
void React
