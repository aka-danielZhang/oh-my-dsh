/**
 * dsh-scheduled-tasks, OhMyMemo adapter row — the `scheduled-tasks-ohmymemo`
 * line. Projects the dream-memory system task into the unified list as a
 * read-only managed provider (design §2.4, §5.2, §11):
 *
 * - the only Host call is `ohMyMemoUi.overview()`; no dream config, cursor,
 *   run audit, or state is ever copied into the scheduler's domain;
 * - no second timer is armed for the dream — its schedule stays owned by
 *   dsh-ohmymemo (§11 接管禁令);
 * - `enabled=false` maps to 已暂停, `enabled=true` to 运行中, and an active
 *   extraction additionally shows 执行中 (§3);
 * - the dream follows the host's ambient local time, so the row honestly
 *   reports `timeZonePolicy: 'host-local'` (§5.2);
 * - `overview()` reads this process's in-memory state; another host's
 *   freshly-finished run may lag until OhMyMemo's next reconcile — the row's
 *   `observedAt` lets the UI show staleness instead of hiding it.
 *
 * The row declares `ohMyMemoUi` a hard dependency: without dsh-ohmymemo the
 * row simply waits (fail soft), the core service and the rest of the page
 * keep working, and no fake unavailable system task is fabricated (§2.4).
 * @module dsh-scheduled-tasks/ohmymemo
 */

import type {} from '@deepseek-ai/cordis-plugin-timer'
import type { Context } from '@deepseek-ai/cordis'
import type { ManagedTaskState, TaskActivity } from './contract.ts'
import type { ManagedTaskProvider } from './index.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-scheduled-tasks/ohmymemo'

/**
 * Only the core registry and the timer service are hard dependencies.
 * `ohMyMemoUi` is read optionally and polled briefly: a pending entry here
 * would fail the whole boot on runtimes that require every entry to activate,
 * and the design demands the opposite — no dsh-ohmymemo installed means no
 * dream row and everything else keeps working (fail soft, design §15.4).
 */
export const inject = ['scheduledTasks', 'timer']

/** Structural view of the OhMyMemo overview (跨插件禁止 import 实现符号). */
interface DreamOverview {
  dream: {
    enabled: boolean
    scheduleLocalTime: string
    timeZone: string
    status: 'idle' | 'running' | 'success' | 'error' | 'cancelled'
    lastAttemptAt: number | null
    lastSuccessAt: number | null
    nextRunAt: number | null
    lastResult: {
      status: 'success' | 'error' | 'cancelled'
      detail: string | null
    } | null
  }
}

interface OhMyMemoUiView {
  overview(): Promise<DreamOverview>
}

interface ScheduledTasksView {
  registerManaged(provider: ManagedTaskProvider): () => void
}

/** Map a settled dream result to the unified activity vocabulary (§3). */
function mapLastResult(lastResult: DreamOverview['dream']['lastResult']): TaskActivity {
  if (lastResult === null) return 'idle'
  return lastResult.status
}

/** The read-only projection of the dream-memory system task. */
function dreamProvider(ui: OhMyMemoUiView): ManagedTaskProvider {
  return {
    id: 'system.ohmymemo.dream',
    order: 0,
    title: '梦境记忆',
    instructionSummary: '整理近期对话并沉淀为长期记忆',
    sourceLabel: '系统任务 · 由记忆设置管理',
    capabilities: { editable: false, pausable: false, deletable: false, runnable: false },
    async snapshot(signal: AbortSignal): Promise<ManagedTaskState> {
      const overview = await ui.overview()
      signal.throwIfAborted()
      const dream = overview.dream
      return {
        schedule: {
          kind: 'daily',
          localTime: dream.scheduleLocalTime,
          timeZone: dream.timeZone,
          timeZonePolicy: 'host-local',
        },
        scheduleState: dream.enabled ? 'enabled' : 'paused',
        activity: dream.status === 'running' ? 'running' : mapLastResult(dream.lastResult),
        lastAttemptAt: dream.lastAttemptAt,
        lastSuccessAt: dream.lastSuccessAt,
        nextRunAt: dream.enabled ? dream.nextRunAt : null,
        detail: dream.lastResult?.detail ?? null,
      }
    },
  }
}

/**
 * Adapter body: register the dream projection as soon as `ohMyMemoUi`
 * appears (it usually is already there — same bundle boot order aside).
 * The returned disposer stops polling and unregisters the projection when
 * this row's fiber unwinds.
 */
export function apply(ctx: Context): () => void {
  const registry = ctx.get('scheduledTasks') as ScheduledTasksView | undefined
  if (registry === undefined) {
    throw new Error(`${name}: scheduledTasks service is not mounted`)
  }
  let registered = false
  let unregister: (() => void) | undefined
  const tryRegister = (): void => {
    if (registered) return
    const ui = ctx.get('ohMyMemoUi') as OhMyMemoUiView | undefined
    if (ui === undefined) return
    unregister = registry.registerManaged(dreamProvider(ui))
    registered = true
  }
  tryRegister()
  const stopPolling = ctx.timer.interval(() => {
    tryRegister()
    if (registered) stopPolling()
  }, 1_000)
  // A dsh-ohmymemo that has not shown up within a minute is not installed;
  // stop looking (the row simply never appears).
  const giveUp = ctx.timer.timeout(() => {
    stopPolling()
  }, 60_000)
  return () => {
    stopPolling()
    giveUp()
    unregister?.()
  }
}
