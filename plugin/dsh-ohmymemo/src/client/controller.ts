/** React-free Remote controller and observable state for the Memory section. */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { RemoteResult, TypertRemoteNamespaceMap } from '@deepseek-ai/dsh-typert-protocol'
import type {
  DreamModelsSnapshot,
  MemoryDocument,
  MemoryOverview,
  MemoryTreeSnapshot,
  UpdateDreamSettingsRequest,
} from '../manager-contract.ts'

export interface MemorySettingsState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  operation: 'settings' | 'run' | 'cancel' | 'read' | 'refresh' | null
  overview: MemoryOverview | null
  tree: MemoryTreeSnapshot | null
  document: MemoryDocument | null
  documentPath: string | null
  models: DreamModelsSnapshot | null
  error: string | null
  notice: 'disabled' | 'already-running' | 'cancelled' | null
}

type MemoryRemote = TypertRemoteNamespaceMap['ohMyMemoUi']

/** One page-lifetime controller; the renderer binds `store` as useMemory. */
export class MemorySettingsController {
  readonly store: SnapshotStore<MemorySettingsState> = createSnapshotStore<MemorySettingsState>({
    status: 'idle',
    operation: null,
    overview: null,
    tree: null,
    document: null,
    documentPath: null,
    models: null,
    error: null,
    notice: null,
  })

  private generation = 0
  private mounted = 0
  private loading = false
  private polling = false
  private disposed = false
  private readonly remote: MemoryRemote

  constructor(remote: MemoryRemote) {
    this.remote = remote
  }

  /** Mark the settings section visible so polling stays page-scoped. */
  mount(): () => void {
    if (this.disposed) return () => {}
    this.mounted += 1
    let active = true
    return () => {
      if (!active) return
      active = false
      this.mounted = Math.max(0, this.mounted - 1)
    }
  }

  /** Load the overview and browser-safe file index together. */
  async load(): Promise<void> {
    const previous = this.store.getSnapshot()
    if (this.disposed || this.loading || (previous.overview !== null && previous.operation !== null)) return
    this.loading = true
    const generation = ++this.generation
    this.store.update((state) => {
      state.status = previous.overview === null ? 'loading' : 'ready'
      state.operation = previous.overview === null ? null : 'refresh'
      state.error = null
    })
    try {
      const [overview, tree, models] = await Promise.all([
        unwrap(this.remote.overview()),
        unwrap(this.remote.tree()),
        this.remote.models().then(result => (result.ok ? result.value : null), () => null),
      ])
      if (!this.isCurrent(generation)) return
      this.store.update((state) => {
        const selected = state.document === null
          ? undefined
          : tree.files.find(file => file.path === state.document?.path)
        if (state.document !== null && (selected === undefined || selected.hash !== state.document.hash)) {
          state.document = null
          state.documentPath = null
        }
        state.status = 'ready'
        state.operation = null
        state.overview = overview
        state.tree = tree
        if (models !== null) state.models = models
        state.error = null
      })
    } catch (error) {
      if (!this.isCurrent(generation)) return
      this.store.update((state) => {
        state.status = state.overview === null ? 'error' : 'ready'
        state.operation = null
        state.error = errorMessage(error)
      })
    } finally {
      this.loading = false
    }
  }

  /** Poll while the Memory section is mounted so scheduled runs remain visible. */
  async tick(): Promise<void> {
    const snapshot = this.store.getSnapshot()
    if (this.disposed || this.mounted === 0 || this.polling || snapshot.operation !== null || snapshot.overview === null) return
    this.polling = true
    const generation = ++this.generation
    try {
      const overview = await unwrap(this.remote.overview())
      if (!this.isCurrent(generation)) return
      const runChanged = overview.dream.lastResult?.runId !== snapshot.overview.dream.lastResult?.runId
      this.store.update((state) => {
        state.overview = overview
        state.error = null
      })
      if (runChanged) await this.load()
    } catch (error) {
      if (!this.isCurrent(generation)) return
      this.store.update((state) => { state.error = errorMessage(error) })
    } finally {
      this.polling = false
    }
  }

  /** CAS-apply one switch or local-time change and fold the returned overview. */
  async updateSettings(patch: Omit<UpdateDreamSettingsRequest, 'ifRevision'>): Promise<void> {
    const overview = this.store.getSnapshot().overview
    if (this.disposed || overview === null || this.store.getSnapshot().operation !== null) return
    const generation = ++this.generation
    this.store.update((state) => {
      state.operation = 'settings'
      state.error = null
      state.notice = null
    })
    try {
      const next = await unwrap(this.remote.updateDreamSettings({
        ifRevision: overview.configRevision,
        ...patch,
      }))
      if (!this.isCurrent(generation)) return
      this.store.update((state) => {
        state.overview = next
        state.operation = null
      })
    } catch (error) {
      if (!this.isCurrent(generation)) return
      const message = errorMessage(error)
      this.store.update((state) => {
        state.operation = null
        state.error = message
      })
      await this.load()
      if (!this.disposed) this.store.update((state) => { state.error = message })
    }
  }

  /** Request one immediate extraction and expose refusal as a locale key. */
  async runNow(): Promise<void> {
    if (this.disposed || this.store.getSnapshot().operation !== null) return
    const generation = ++this.generation
    this.store.update((state) => {
      state.operation = 'run'
      state.error = null
      state.notice = null
    })
    try {
      const result = await unwrap(this.remote.runNow())
      const overview = await unwrap(this.remote.overview())
      if (!this.isCurrent(generation)) return
      this.store.update((state) => {
        state.operation = null
        state.overview = overview
        state.notice = result.started ? null : result.reason ?? null
      })
    } catch (error) {
      if (!this.isCurrent(generation)) return
      this.store.update((state) => {
        state.operation = null
        state.error = errorMessage(error)
      })
    }
  }

  /** Request cancellation of the currently active extraction job. */
  async cancelRun(): Promise<void> {
    if (this.disposed || this.store.getSnapshot().operation !== null) return
    const generation = ++this.generation
    this.store.update((state) => {
      state.operation = 'cancel'
      state.error = null
      state.notice = null
    })
    try {
      const result = await unwrap(this.remote.cancelRun())
      const overview = await unwrap(this.remote.overview())
      if (!this.isCurrent(generation)) return
      this.store.update((state) => {
        state.operation = null
        state.overview = overview
        state.notice = result.cancelled ? 'cancelled' : null
      })
    } catch (error) {
      if (!this.isCurrent(generation)) return
      this.store.update((state) => {
        state.operation = null
        state.error = errorMessage(error)
      })
    }
  }

  /** Read one file against the generation that produced its tree row. */
  async read(path: string): Promise<void> {
    const snapshot = this.store.getSnapshot()
    const tree = snapshot.tree
    if (this.disposed || tree === null || snapshot.operation !== null) return
    const generation = ++this.generation
    this.store.update((state) => {
      state.operation = 'read'
      state.documentPath = path
      state.document = null
      state.error = null
    })
    try {
      const document = await unwrap(this.remote.read({ path, generation: tree.generation }))
      if (!this.isCurrent(generation)) return
      this.store.update((state) => {
        state.operation = null
        state.document = document
      })
    } catch (error) {
      if (!this.isCurrent(generation)) return
      this.store.update((state) => {
        state.operation = null
        state.error = errorMessage(error)
      })
    }
  }

  /** Clear transient feedback after the user moves to another action. */
  clearFeedback(): void {
    if (this.disposed) return
    this.store.update((state) => {
      state.error = null
      state.notice = null
    })
  }

  /** Invalidate late responses after the Client plugin is disposed. */
  dispose(): void {
    this.disposed = true
    this.generation += 1
  }

  private isCurrent(generation: number): boolean {
    return !this.disposed && generation === this.generation
  }
}

async function unwrap<T>(result: Promise<RemoteResult<T>>): Promise<T> {
  const settled = await result
  if (!settled.ok) throw new Error(`${settled.error.code}: ${settled.error.message}`)
  return settled.value
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
