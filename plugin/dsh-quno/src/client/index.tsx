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
 * Everything except settings, the task card, turn-tail actions and Workspace
 * session visibility is gated on the master switch (`config.enabled`): turning
 * it off disposes the gated registrations without leaking Quno's durable main
 * conversation back into ordinary work browsing.
 *
 * @module dsh-quno/client
 */

import React from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type { QueueAction } from '@deepseek-ai/dsh-api-session-controller/types'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { QunoLocaleKey } from './locales.ts'
import type { QunoRemoteFace } from './store.ts'
import type { SidebarRightFace } from './capsule.tsx'
import type { QunoConversationFace } from './report-actions.tsx'
import type { QunoQueueDockInjected } from './queue-dock.tsx'
import TYPERT_REMOTE from '../typert.remote-client.ts'
import { QunoClientStore } from './store.ts'
import { en, zh } from './locales.ts'
import { QunoSettingsSection } from './settings.tsx'
import { QunoMainMarker, QunoPresetLabelShadow } from './marker.tsx'
import { QunoPanelTab, QunoPanelTitle } from './panel.tsx'
import { QunoCapsule } from './capsule.tsx'
import { QunoCliCallCard, QunoExchangeCard } from './tool-cards.tsx'
import { QunoWorkEntry } from './work-entry.tsx'
import { QunoLeadingIdentity, QunoWorkerCommands, WorkerComposerTakeover, selectWorkerComposer } from './worker-session.tsx'
import { createWorkNavigation, workerOpenFailure } from './work-navigation.ts'
import type { WorkerMissing } from './task-list.tsx'
import { QunoHeroWelcome } from './hero-welcome.tsx'
import { QunoTaskCard } from './task-card.tsx'
import { QunoReportActions } from './report-actions.tsx'
import { QunoEntryPanel, QunoEntryGlyph } from './entry-panel.tsx'
import { QunoOnboardingHost, onboarding } from './collector-onboarding.tsx'
import { qunoNoticeDefinition } from './report-turn.ts'
import { registerInternalQueueKinds } from './queue-internal.ts'
import { QunoQueueDock, QUNO_QUEUE_CSS } from './queue-dock.tsx'
import { qunoWorkspaceSessionVisible, surfaceEnabled } from './view-model.ts'
import { QUNO_PANEL_ID, QUNO_PANEL_KIND } from './right-tab.ts'
import { QUNO_CSS, QUNO_WORK_CSS } from './ui.tsx'

/** Dictionary namespace owned by this plugin. */
const NS = 'quno'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Quno browser copy. */
    quno: QunoLocaleKey
  }
}

/** Required client services (the two sidebar services are optional: duck-checked). */
// `layout` and `uiWorkspace` are load-bearing, not optional: the entry row's
// hand-off reads both during apply. Declaring them here makes the fiber wait
// for the services instead of racing their providers (a boot-order loss left
// `ctx.get('uiWorkspace')` undefined for the whole session, so opening Quno
// silently did nothing and the visibility filter never registered).
export const inject = ['slots', 'locale', 'remote', 'sessions', 'layout', 'uiWorkspace']

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
  /** Workspace list (optional): Quno's main session joins the first workspace
   * so the stock composer is live without a manual choice. */
  /** Live provider/model routes for the settings model selector. Resolved
   * lazily and defensively: the llm namespace is optional in composed
   * runtimes, and a missing remote must not fail this plugin's apply. */
  const listModelChoices = async (): Promise<{ provider: string; model: string; name: string }[]> => {
    let llm: {
      listProviders?: () => Promise<{ readonly ok: boolean; readonly value?: readonly { readonly id: string; readonly name: string }[] }>
      listModels?: (provider: string) => Promise<{ readonly ok: boolean; readonly value?: readonly { readonly provider: string; readonly id: string; readonly name: string }[] }>
    } | undefined
    // The Session controller's catalog is mounted with the core conversation
    // surface and carries the same routes the composer offers.
    try {
      const sessionRemote = ctx.get('remote.session') as {
        modelCatalog?: () => Promise<{
          readonly ok: boolean
          readonly value?: {
            readonly groups?: readonly {
              readonly id: string
              readonly models?: readonly { readonly id: string; readonly name: string }[]
            }[]
          }
        }>
      } | undefined
      const catalog = await sessionRemote?.modelCatalog?.()
      if (catalog?.ok === true) {
        const out: { provider: string; model: string; name: string }[] = []
        for (const group of catalog.value?.groups ?? []) {
          for (const model of group.models ?? []) out.push({ provider: group.id, model: model.id, name: model.name })
        }
        if (out.length > 0) return out
      }
    } catch { /* fall through to the llm registry */ }
    try {
      llm = ((ctx.remote as unknown as { llm?: unknown }).llm ?? ctx.get('remote.llm')) as typeof llm
    } catch {
      return []
    }
    if (llm?.listProviders === undefined || llm.listModels === undefined) return []
    try {
      const providers = await llm.listProviders()
      if (!providers.ok) return []
      const out: { provider: string; model: string; name: string }[] = []
      for (const provider of providers.value ?? []) {
        const models = await llm.listModels(provider.id)
        if (!models.ok) continue
        for (const model of models.value ?? []) out.push({ provider: provider.id, model: model.id, name: model.name })
      }
      return out
    } catch {
      return []
    }
  }
  const workspaces = ctx.get('workspaces') as {
    list?: { getSnapshot?: () => { items?: readonly { workspaceId?: string }[] } }
  } | undefined
  const defaultWorkspaceId = (): string | undefined => {
    try { return workspaces?.list?.getSnapshot?.().items?.[0]?.workspaceId } catch { return undefined }
  }
  const sidebarRight = hasMethod(ctx.get('sidebarRight'), 'openTab')
    ? (ctx.get('sidebarRight') as unknown as SidebarRightFace)
    : undefined
  const sidebarRightTabs = hasMethod(ctx.get('sidebarRightTabs'), 'register')
    ? (ctx.get('sidebarRightTabs') as unknown as SidebarRightTabsFace)
    : undefined
  const workspace = ctx.get('uiWorkspace') as {
    openSession(sessionId: SessionId): void
    registerSessionVisibilityFilter?: (filter: (session: {
      readonly projectionValues?: { readonly agentPreset?: string | null }
    }) => boolean) => () => void
  } | undefined
  const openSession = (sessionId: string): void => {
    workspace?.openSession(sessionId as SessionId)
  }
  // The entry panel's hand-off target: from a selected panel back to the
  // Conversation view (absent layout service → no-op; the panel degrades to
  // its loading line).
  const backToConversation = (): void => {
    const layout = ctx.get('layout') as { selectPanel(panelId: null): void } | undefined
    layout?.selectPanel(null)
  }
  // Best-effort vertical scroll of the active conversation content (v2 §3
  // returnContext): read at entry, restored after the session switch.
  const readMainScrollForReturn = (): number | null => {
    if (typeof document === 'undefined') return null
    const content = document.querySelector('[data-conversation-content]')
    return content === null ? null : content.scrollTop
  }
  // Client-only work navigation (design v2 §3/§9.3): remembers how to come
  // back from a worker session and keeps every operation view-level — it
  // never calls launch/resume/stop and never writes the domain store.
  const workNavigation = createWorkNavigation({
    openSession,
    selectMainPanel: backToConversation,
    openWorkPanel: () => { sidebarRight?.openTab(QUNO_PANEL_KIND, { params: { view: 'task' } }) },
    workPanelVisible: () => typeof document !== 'undefined' && document.querySelector('[data-quno-panel]') !== null,
    readMainScroll: readMainScrollForReturn,
    restoreMainScroll: (y: number) => {
      if (typeof document === 'undefined') return
      // The conversation content remounts after the session switch; retry a
      // few frames before giving up (best-effort by design, v2 §3).
      let attempts = 0
      const apply = (): void => {
        const content = document.querySelector('[data-conversation-content]')
        if (content !== null) { content.scrollTop = y; return }
        if (attempts >= 3) return
        attempts += 1
        requestAnimationFrame(apply)
      }
      requestAnimationFrame(apply)
    },
    focusWorkEntry: () => {
      if (typeof document === 'undefined') return
      const entry = document.querySelector('[data-quno-work-entry]')
      if (entry !== null && typeof (entry as HTMLElement).focus === 'function') (entry as HTMLElement).focus()
    },
    fallbackMainSessionId: () => store.getSnapshot().state?.main.sessionId ?? null,
  }, typeof window !== 'undefined' && typeof window.sessionStorage !== 'undefined' ? window.sessionStorage : null)

  /**
   * Open a worker's native session (design v2 §9.3): resolve the executor
   * session Host-side by ticketId, verify the identity echo, remember the
   * return context, then switch. Failures land in `report` — the work list
   * shows the honest missing page; nothing is auto-created.
   */
  const openWorkerSession = async (
    ticketId: string,
    keyboard: boolean,
    report: (missing: WorkerMissing) => void,
  ): Promise<void> => {
    const result = await store.workerDetail(ticketId)
    const failure = workerOpenFailure(result, ticketId)
    if (failure !== null) {
      const statusText = result.ok === true ? result.value.status : null
      report({ ticketId, reason: failure, statusText, keyboard })
      return
    }
    if (result.ok !== true) return
    const detail = result.value
    if (detail.executorSessionId === null) return
    const mainSessionId = store.getSnapshot().state?.main.sessionId ?? null
    workNavigation.enterWorker({
      mainSessionId: mainSessionId ?? '',
      workPanelOpen: true,
      scrollY: readMainScrollForReturn(),
      entry: 'worker-list',
      keyboard,
    })
    try {
      openSession(detail.executorSessionId)
    } catch {
      report({ ticketId, reason: 'detail-failed', statusText: null, keyboard })
    }
  }

  // Queue-dock operations, resolved per session exactly like the stock dock's
  // inject (the conversation service is session-scoped; image URLs come from
  // uiConversation). Structural faces — no harness value imports.
  const queueDockFace = (sessionId: SessionId): QunoQueueDockInjected => {
    const sessionsRoot = ctx.get('sessions') as unknown as {
      scope?(id: string): { get(name: string): unknown } | undefined
    } | undefined
    const actx = sessionsRoot?.scope?.(sessionId)
    if (actx === undefined) throw new Error(`queue dock: session "${String(sessionId)}" resolved no scope`)
    const conversation = actx.get('conversation') as
      | {
        updateQueue(itemId: string, action: QueueAction): Promise<void>
        input: { for(scope: unknown): { notify(level: 'info' | 'error', text: string): void } }
      }
      | undefined
    if (conversation === undefined) throw new Error('queue dock: conversation service unavailable')
    const imageFace = uiConversation as unknown as
      | { imageUrl?(id: string, attachment: { attachmentId: string }): Promise<string> }
      | undefined
    return {
      updateQueue: (itemId, action) => conversation.updateQueue(itemId, action),
      notify: (level, text) => { conversation.input.for(actx).notify(level, text) },
      loadImage: attachment => imageFace?.imageUrl !== undefined
        ? imageFace.imageUrl(sessionId, attachment)
        : Promise.reject(new Error('queue dock: image URL service unavailable')),
    }
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
  // The Conversation assembly service is optional in a composed runtime; the
  // turn-bound report card simply renders nothing without it.
  const uiConversation = ctx.get('uiConversation') as unknown as QunoConversationFace | undefined
  const openCollectorPanel = (instanceId: string): void => {
    if (!panelReady || sidebarRight === undefined) return
    sidebarRight.openTab(QUNO_PANEL_KIND, { params: { collectorId: instanceId, view: 'collectors' } })
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

    // Workspace visibility filter (§13.2): RESTORED (2026-10-30 晚) together
    // with the entry fix — the hand-off was ordered wrong (openSession ran
    // while this hand-off panel owned the main region, so uiWorkspace could
    // not land the switch); swapping backToConversation before openSession
    // makes the entry navigate. On runtime zw.7 the filter method itself is
    // absent (contributed visibility landed at fork 450ef07f, after the
    // zw.7 tag) so this degrades to a no-op there until the next fork layer;
    // the duck-check keeps that safe. See
    // docs/notes/2026-10-30-quno-entry-navigation-fix.md.
    const registerVisibility = workspace?.registerSessionVisibilityFilter
    if (registerVisibility !== undefined) {
      ctx.effect(
        () => registerVisibility.call(workspace, qunoWorkspaceSessionVisible),
        'dsh-quno: Workspace main-session visibility',
      )
    }
    if (registerVisibility === undefined) void qunoWorkspaceSessionVisible

    // The settings section is Quno's home for configuration; operational state
    // and the main-conversation entry live outside the settings dialog.
    ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section',
      id: 'quno',
      order: 12,
      label: () => t('nav'),
      inject: () => ({ store, t, listModelChoices }),
    }, QunoSettingsSection))

    // Inline task card for quno_task calls (registered ungated: historic cards
    // stay readable; the panel action degrades through `openPanel`).
    ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
      name: 'tool.call.toolview',
      key: 'quno_task',
      inject: () => ({ store, t, openPanel }),
    }, QunoTaskCard))

    // Redacted cards for the Quno-owned worker tools (design v2 §6.2): the
    // stock transcript would render raw arguments — including hallucinated
    // credential parameters — so these keyed views shadow it with the
    // denylist-redacted, bounded projection (redaction.ts). Ungated: a
    // worker session viewed while the master switch is off stays scrubbed.
    ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
      name: 'tool.call.toolview',
      key: 'quno_cli_call',
      inject: () => ({ t }),
    }, QunoCliCallCard))
    ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
      name: 'tool.call.toolview',
      key: 'quno_exchange',
      inject: () => ({ t }),
    }, QunoExchangeCard))

    // Queue display filter (design §7.1): program-injected inputs never
    // surface as queued rows above the composer. Two signals cooperate — the
    // forward `presentation: 'internal'` flag on new sources and this legacy
    // kind registry for durable records that cannot be rewritten. Ungated:
    // queued program rows from before a master-switch flip must still hide.
    ctx.effect(() => registerInternalQueueKinds(['quno-eval', 'quno-report', 'quno-notify', 'quno-task']), 'dsh-quno: internal queue kinds')

    // The internal-aware queue strip shadows the stock dock entry (same entry
    // id `queue`, lower priority renders): identical UI, plus the display
    // filter. Human rows keep edit/remove/steer; the filter only affects
    // display and the model still receives every queued message.
    ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
      name: 'conversation.input.dock',
      id: 'queue',
      priority: -1,
      locale: 'conversation',
      inject: (sessionId: SessionId) => queueDockFace(sessionId),
    }, QunoQueueDock))

    // A durable program input becomes one hidden Chat node bound to its own
    // Turn; the tail card below reads notices back by notification id.
    const noticeRegistry = uiConversation as unknown as {
      events?: { register(definition: unknown): () => void }
    } | undefined
    if (noticeRegistry?.events !== undefined) {
      ctx.effect(() => noticeRegistry.events!.register(qunoNoticeDefinition), 'dsh-quno: notice-to-turn binding')
    }
    // Support marker (same spirit as `data-quno-main`): whether the Turn
    // binding could reach the Conversation assembly at all.
    if (typeof document !== 'undefined') {
      document.documentElement.dataset.qunoNoticeBinding = noticeRegistry?.events === undefined ? 'off' : 'on'
    }

    // Deterministic report actions at the turn tail of the Quno conversation.
    ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
      name: 'conversation.chat.turnTail',
      id: 'quno-report-actions',
      order: 30,
      inject: () => ({ store, t, ...(uiConversation === undefined ? {} : { conversation: uiConversation }) }),
    }, QunoReportActions))

    // The onboarding wizard floats over the whole app (a 300+form+240 layout
    // cannot fit the 800px settings dialog). Ungated like settings: a user may
    // connect a source while the master switch is off.
    ctx.slots.inject('shell.overlay', () => ctx.slots.register({
      name: 'shell.overlay',
      id: 'quno-onboarding',
      order: 40,
      inject: () => ({ store, t, onOpenDetail: openCollectorPanel }),
    }, QunoOnboardingHost))

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

    // The worker-surface stylesheet (same claim discipline as the skin CSS).
    ctx.effect(() => {
      const tagId = 'dsh-quno/worker-css'
      if (document.querySelector(`style[data-plugin-css="${tagId}"]`) !== null) return () => {}
      const style = document.createElement('style')
      style.dataset.plugin = 'dsh-quno'
      style.dataset.pluginCss = tagId
      style.textContent = QUNO_WORK_CSS
      document.head.appendChild(style)
      return () => { style.remove() }
    })

    // The queue strip's stylesheet (same claim discipline as the skin CSS).
    ctx.effect(() => {
      const tagId = 'dsh-quno/queue-css'
      if (document.querySelector(`style[data-plugin-css="${tagId}"]`) !== null) return () => {}
      const style = document.createElement('style')
      style.dataset.plugin = 'dsh-quno'
      style.dataset.pluginCss = tagId
      style.textContent = QUNO_QUEUE_CSS
      document.head.appendChild(style)
      return () => { style.remove() }
    })

    // ---------------------------------------------------------- gated surface
    // Registered while the master switch is on; disposed (stock UI returns)
    // while it is off. `slots.inject` ties each contribution to this fiber, so
    // a plugin unload cleans up even if the listener never fires again.
    const registerGated = (): void => {
      // Sidebar entry (§13.2): a native panel row under Automations — the
      // shell owns the row styling, so it reads as one of its own. The panel
      // page itself is a hand-off: on mount it opens the one main conversation
      // and returns the layout to the Conversation view.
      held.push(ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: 'quno-entry',
        locale: NS,
        inject: () => ({ store, t, openSession, backToConversation, defaultWorkspaceId }),
      }, QunoEntryPanel)))
      held.push(ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: 'quno-entry',
        order: 30,
        label: () => t('nav'),
        // The row stands for the Quno Conversation, not only for this hand-off
        // panel: once the hand-off clears the layout's active panel, the shell
        // keeps the row selected from the main Session's `agentPreset`
        // projection (ui-sidebar fork capability, runtime zw.9). The id is the
        // preset `presets.ts` registers; an older runtime ignores this option
        // and keeps the panel-only selection, never crashing.
        conversationAgentPreset: 'quno',
      }, QunoEntryGlyph)))

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
          inject: () => ({
            store,
            t,
            onOpenWorker: (ticketId: string, keyboard: boolean, report: (missing: WorkerMissing) => void) => {
              void openWorkerSession(ticketId, keyboard, report)
            },
            onWorkerMissingBack: (keyboard: boolean) => { workNavigation.returnToMainFromPanel(keyboard) },
            onEditCollector: (instanceId: string, type: string) => { onboarding.open({ kind: 'edit', instanceId, type }) },
            onAddCollector: () => { onboarding.open({ kind: 'create' }) },
          }),
        }, QunoPanelTab)))
        held.push(ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab.title',
          key: QUNO_PANEL_ID,
          inject: () => ({ store, t }),
        }, QunoPanelTitle)))
        panelReady = true
      }

      // In-conversation capsule (§13.5): the slot only provides session
      // context — the visible pill is portaled into this session's
      // [data-conversation-content] corner, never the header button row.
      // It yields to the open panel and disappears when nothing is pending.
      if (sidebarRight !== undefined) {
        held.push(ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
          name: 'conversation.session.header.utilities',
          id: 'quno-work-entry',
          order: 45,
          inject: () => ({ store, t, face: sidebarRight }),
        }, QunoWorkEntry)))
        held.push(ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
          name: 'conversation.session.header.utilities',
          id: 'quno-capsule',
          order: 60,
          inject: () => ({ store, t, face: sidebarRight }),
        }, QunoCapsule)))
      }

      // Combined header identity (design v2 §6.1 + §13.8): the Quno main
      // identity on a main, the worker identity (返回 Quno + title + Worker
      // label + status) on an executor session. ONE registration — the slot
      // is single-kind, a second entry would shadow this cell outright.
      held.push(ctx.slots.inject('conversation.header.leading', () => ctx.slots.register({
        name: 'conversation.header.leading',
        priority: -1,
        inject: () => ({ store, t, onBack: (keyboard: boolean) => { workNavigation.backToQuno() } }),
      }, QunoLeadingIdentity)))

      // First-open welcome (§13.8): avatar + welcome line + opener chips on
      // the hero of a Quno main (the marker's hero seat carries the claim).
      held.push(ctx.slots.inject('conversation.hero.options', () => ctx.slots.register({
        name: 'conversation.hero.options',
        id: 'quno-welcome',
        order: 20,
        inject: () => ({ store, t }),
      }, QunoHeroWelcome)))

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

      // Worker commands (design v2 §6.1): 停止/重试 per status, on the actions
      // seat — never nested inside a work-list row button (v2 §5.2).
      held.push(ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
        name: 'conversation.session.header.actions',
        id: 'quno-worker-commands',
        order: 20,
        inject: () => ({ store, t }),
      }, QunoWorkerCommands)))

      // Read-only composer takeover (design v2 §6.2/§9.4 client half): the
      // chain elect replaces the composer for executor sessions with the
      // read-only notice + collapsible task summary. Program inputs bypass
      // the composer entirely, so TicketInput and worker output keep flowing;
      // the Host-side submit gate stays the recorded fork follow-up (§18.3).
      held.push(ctx.slots.inject('conversation.composer', () => ctx.slots.register({
        name: 'conversation.composer',
        priority: -10,
        locale: NS,
        select: selectWorkerComposer,
        inject: () => ({ store, t, onBack: (keyboard: boolean) => { workNavigation.backToQuno() } }),
      }, WorkerComposerTakeover)))
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
