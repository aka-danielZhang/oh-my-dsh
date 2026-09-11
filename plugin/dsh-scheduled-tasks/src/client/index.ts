/**
 * Browser half: mounts the scheduledTasks Remote contribution, registers the
 * `main` panel that renders the task page, and installs the sidebar entry that
 * selects it.
 *
 * Entry posture (2026-09-11 review): the panel is reached from the sidebar's
 * session-browser header, beside the search control — the position the design
 * was signed off in — and NOT from a settings section, which was removed. The
 * session browser declares no action seat there, so ./entry.ts decorates that
 * row; the panel itself is a real slot registration on the layout's keyed
 * `main` seat, so `ctx.layout.selectPanel` drives it like any other panel.
 *
 * The Remote namespace is mounted by this fiber when the shell's selection has
 * not already provided it (mcp-settings pattern), and the whole body is
 * effect-scoped: disposing the fiber withdraws the panel, the entry and the
 * stylesheet (`disposeRemote` settles asynchronously, fire-and-forget).
 * @module dsh-scheduled-tasks/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls api-gateway's cordis Context merge (ctx.remote) so the
// Remote mount below typechecks against the gateway face.
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the layout's Context merge (ctx.layout) plus the `main` seat's
// SlotMap entry this plugin registers into.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
// Type-only: pulls the renderer's Context merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import TYPERT_REMOTE from '../typert.remote-client.ts'
import type {
  CatalogSnapshot,
  CreateTaskRequest,
  DeleteRunRequest,
  ListSnapshot,
  RemoveTaskRequest,
  RunList,
  SetEnabledRequest,
  TaskIdRequest,
  UpdateTaskRequest,
  UserTaskRow,
} from '../types.ts'
import { AutomationPage, type AutomationPageProps, type ScheduledTasksFace } from './AutomationPage.tsx'
import { PANEL_KEY, installEntry, type LayoutFace } from './entry.ts'
import { en, zh, type ScheduledTasksLocaleKey } from './locales.ts'
import { injectStyles } from './styles.ts'

/** Dictionary namespace owned by this plugin. */
const NS = 'scheduled-tasks'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** scheduled-tasks page copy. */
    'scheduled-tasks': ScheduledTasksLocaleKey
  }
}

/** Structural view of the mounted Remote namespace (instance-agnostic). */
type RemoteOutcome<Value> =
  | { ok: true, value: Value }
  | { ok: false, error: { code: string, message: string } }

interface ScheduledTasksRemote {
  list(): Promise<RemoteOutcome<ListSnapshot>>
  catalog(): Promise<RemoteOutcome<CatalogSnapshot>>
  create(request: CreateTaskRequest): Promise<RemoteOutcome<UserTaskRow>>
  update(request: UpdateTaskRequest): Promise<RemoteOutcome<UserTaskRow>>
  setEnabled(request: SetEnabledRequest): Promise<RemoteOutcome<UserTaskRow>>
  deleteTask(request: RemoveTaskRequest): Promise<RemoteOutcome<{ removed: true }>>
  runNow(request: TaskIdRequest): Promise<RemoteOutcome<UserTaskRow>>
  listRuns(request: TaskIdRequest): Promise<RemoteOutcome<RunList>>
  deleteRun(request: DeleteRunRequest): Promise<RemoteOutcome<{ removed: true }>>
}

/**
 * Required Client services: the slot registry, the locale registry, the Remote
 * gateway (the apply awaits ctx.remote.$mount), and the layout controller the
 * sidebar entry toggles through. The mounted namespace itself is read through
 * the string-keyed ctx.get (usage-stats posture).
 */
export const inject = ['slots', 'locale', 'remote', 'layout']

/** Register the panel and its sidebar entry. */
export async function apply(ctx: ClientContext): Promise<() => Promise<void>> {
  // Mount our own generated-equivalent contribution when the shell's
  // selection has not already provided the namespace (mcp-settings pattern).
  const disposeRemote = ctx.get('remote.scheduledTasks') === undefined
    ? await ctx.remote.$mount(TYPERT_REMOTE)
    : async (): Promise<void> => {}
  const remote = ctx.get('remote.scheduledTasks') as ScheduledTasksRemote | undefined
  if (remote === undefined) {
    await disposeRemote()
    throw new Error('dsh-scheduled-tasks: scheduledTasks Remote did not mount')
  }

  try {
    ctx.effect(() => injectStyles('dsh-scheduled-tasks'), 'dsh-scheduled-tasks: page styles')
    ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-scheduled-tasks: dictionaries')

    const t = ctx.locale.bind(NS) as AutomationPageProps['t']

    const unwrap = <Value>(outcome: RemoteOutcome<Value>): Value => {
      if (!outcome.ok) {
        const error = new Error(`${outcome.error.code}: ${outcome.error.message}`) as Error & { code: string }
        error.code = outcome.error.code
        throw error
      }
      return outcome.value
    }
    const face: ScheduledTasksFace = {
      list: async () => unwrap(await remote.list()),
      catalog: async () => unwrap(await remote.catalog()),
      create: async request => unwrap(await remote.create(request)),
      update: async request => unwrap(await remote.update(request)),
      setEnabled: async request => unwrap(await remote.setEnabled(request)),
      deleteTask: async request => unwrap(await remote.deleteTask(request)),
      runNow: async request => unwrap(await remote.runNow(request)),
      listRuns: async request => unwrap(await remote.listRuns(request)),
      deleteRun: async request => unwrap(await remote.deleteRun(request)),
      openSession: sessionId => {
        // The conversation is the `null` main panel; the session row click
        // lands the user in the sidebar list, opened on this session.
        ;(ctx.layout as unknown as { selectPanel(id: string | null): void }).selectPanel(null)
        const sessions = ctx.get('sessions') as { open(sessionId: string): void } | undefined
        sessions?.open(sessionId)
      },
    }

    const slots = ctx.get('slots') as unknown as SlotRegistry
    ctx.effect(
      () => slots.inject('main', () => slots.register(
        {
          name: 'main',
          key: PANEL_KEY,
          locale: NS,
          inject: (): AutomationPageProps => ({ face, t }),
        },
        AutomationPage,
      )),
      'dsh-scheduled-tasks: main panel',
    )
    ctx.effect(
      () => installEntry(ctx.layout as unknown as LayoutFace, () => t('nav')),
      'dsh-scheduled-tasks: sidebar entry',
    )
    return disposeRemote
  } catch (error) {
    await disposeRemote()
    throw error
  }
}
