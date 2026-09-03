import type { SessionListState, WorkspaceListState } from '@deepseek-ai/dsh-client-runtime/client'

/** Session-list selector. Structural so SlotMap/store type merges cannot collapse it to `any`. */
export type UseSessions = <T>(selector: (state: SessionListState) => T) => T
/** Workspace-list selector used by the Thread-grouped sidebar view. */
export type UseWorkspaces = <T>(selector: (state: WorkspaceListState) => T) => T
