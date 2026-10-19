/** Structural subset of the ui-settings ConfigForm face this store binds. */
interface SettingsScope<T> {
  getSnapshot(): { value?: T }
  subscribe(listener: () => void): () => void
}
import { DEFAULT_THREAD_SETTINGS, type ThreadSettings } from '../thread-types.ts'

/**
 * Boolean external store over the Host `dsh-thread` settings namespace. The
 * scope's snapshot store already notifies per committed change; the derived
 * primitive keeps useSyncExternalStore comparisons by value. While the mirror
 * loads, the namespace default (on) applies so the feature never flickers off
 * for a user who never touched the switch.
 */
export interface ThreadEnabledStore {
  getSnapshot(): boolean
  subscribe(listener: () => void): () => void
}

/** Bind the Thread master switch to the browser settings mirror. */
export function bindThreadEnabled(scope: SettingsScope<ThreadSettings>): ThreadEnabledStore {
  return {
    getSnapshot: () => scope.getSnapshot().value?.enabled ?? DEFAULT_THREAD_SETTINGS.enabled,
    subscribe: listener => scope.subscribe(listener),
  }
}
