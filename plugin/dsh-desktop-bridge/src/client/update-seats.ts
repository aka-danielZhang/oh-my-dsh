/**
 * Seat placement for the quiet updater: the sidebar header action on runtimes
 * that declare the fork's `sidebar.header.action` slot (0.2.1-rc.2+zw.4), the
 * stock `sidebar.footer.action` on older ones. Both are registered only after
 * ui-sidebar's `sidebar` declaration lands, because `slots.inject` treats a
 * missing declaration as "wait", never as a failure — the old-runtime fallback
 * therefore keys off the declared slots, not off a rejected registration
 * (rc.45 discipline: a decorative seat must never take the bridge down).
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { UpdateIndicatorInjected } from './update-indicator.tsx'
import { HeaderUpdateControl, UpdateBadge, UpdateControl } from './update-indicator.tsx'

/** Logger face used by the installers (the cordis logger satisfies this). */
export interface WarnLog {
  warn(message: string): void
}

/** The slot-registry surface seat placement needs (inject is the caller's job). */
export type SeatRegistry = Pick<ClientContext['slots'], 'register' | 'spec'>

/** Which seat carries the updater on the runtime that is currently loaded. */
export type UpdateSeat = 'header' | 'footer'

/**
 * Pick the updater's seat from the runtime's declared slots. `sidebar`'s
 * children are committed with its declaration, so a header slot that is still
 * missing here belongs to a runtime that predates it.
 * @param registry - the live slot registry.
 * @returns the seat to populate.
 */
export function pickUpdateSeat(registry: Pick<SeatRegistry, 'spec'>): UpdateSeat {
  return registry.spec('sidebar.header.action') === undefined ? 'footer' : 'header'
}

/** Register one updater seat, degrading to a warning instead of a crash. */
function registerSeat(
  registry: SeatRegistry,
  seat: UpdateSeat,
  injected: () => UpdateIndicatorInjected,
  logger: WarnLog,
): (() => void) | undefined {
  try {
    return seat === 'header'
      ? registry.register({ name: 'sidebar.header.action', priority: -1, locale: 'desktop-bridge', inject: injected }, HeaderUpdateControl)
      : registry.register({ name: 'sidebar.footer.action', id: 'desktop-update', order: 20, locale: 'desktop-bridge', inject: injected }, UpdateControl)
  } catch (error) {
    logger.warn(`dsh-desktop-bridge: updater seat ${seat} unavailable: ${String(error)}`)
    return undefined
  }
}

/**
 * Register the updater seats for one `sidebar` declaration lifetime.
 * @param registry - the live slot registry.
 * @param injected - the updater face handed to each seat.
 * @param logger - warning sink (fallbacks and optional-seat failures).
 * @returns the disposers for every registration that succeeded.
 */
export function installUpdateSeats(
  registry: SeatRegistry,
  injected: () => UpdateIndicatorInjected,
  logger: WarnLog,
): Array<() => void> {
  const disposers: Array<() => void> = []
  const preferred = pickUpdateSeat(registry)
  if (preferred === 'footer') {
    logger.warn('dsh-desktop-bridge: sidebar.header.action is not declared by this runtime — keeping the updater in sidebar.footer.action')
  }
  const seat = registerSeat(registry, preferred, injected, logger)
    ?? (preferred === 'header' ? registerSeat(registry, 'footer', injected, logger) : undefined)
  if (seat !== undefined) disposers.push(seat)
  // The collapsed-rail badge shadows ui-settings-general's inert official
  // badge (priority 0): lowest priority renders, and a same-priority claim
  // would throw.
  try {
    disposers.push(registry.register({ name: 'sidebar.toggle.badge', priority: -1, locale: 'desktop-bridge', inject: injected }, UpdateBadge))
  } catch (error) {
    logger.warn(`dsh-desktop-bridge: collapsed-rail update badge unavailable: ${String(error)}`)
  }
  return disposers
}
