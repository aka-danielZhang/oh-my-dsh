import type {} from '@deepseek-ai/dsh-client-ui-slots'

/**
 * Compile-time shim: the `sidebar.workspaces.sessionListView` declaration ships
 * with the fork's ui-workspace (`SessionListView` seam). Until the plugin's
 * devDependencies resolve a build carrying it, augment the SlotMap locally so
 * the registration typechecks; the shapes must stay identical so the fork's
 * own merge keeps compiling once both are present.
 */
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** Alternative session-list views for the sidebar browsing region (list; the owner renders one entry by id). */
    'sidebar.workspaces.sessionListView': { kind: 'list'; scope: 'root' }
  }
}

export {}
