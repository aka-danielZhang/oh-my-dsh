import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { afterEach, beforeEach, vi } from 'vitest'
/** Structural stand-in for the ui-settings ConfigForm face this plugin consumes. */
interface SettingsScope<T> {
  getSnapshot(): SettingsScopeSnapshot<T>
  subscribe(listener: () => void): () => void
  set(field: string, value: unknown): Promise<boolean>
  unset(field: string): Promise<boolean>
  mutate(ops: readonly { op: 'set' | 'unset', path: (string | number)[], value?: unknown }[], expectedRevision?: number): Promise<boolean>
}
interface SettingsScopeSnapshot<T> {
  status: string
  value?: T
  base?: unknown
  user?: unknown
  revision?: number
  writable: boolean
}

/** Execute the published browser factory with the same explicit imports as the loader. */
export function loadBrowserModule(specifier: string, imports: Record<string, unknown>): Record<string, unknown> {
  const require = createRequire(import.meta.url)
  let factory: ((require: (id: string) => unknown) => Record<string, unknown>) | undefined
  runInNewContext(readFileSync(require.resolve(specifier), 'utf8'), {
    navigator, document, localStorage, console, setTimeout, clearTimeout, queueMicrotask,
    window: { __ModuleLoader__: { load: (entry: { factory: typeof factory }) => { factory = entry.factory } } },
  })
  if (!factory) throw new Error(`Missing browser factory: ${specifier}`)
  return factory((id) => {
    if (!(id in imports)) throw new Error(`Missing browser import: ${id}`)
    return imports[id]
  })
}

export function usePinnedBrowserLanguages(primary: string): void {
  beforeEach(() => {
    Object.defineProperty(navigator, 'languages', { value: [primary], configurable: true })
    Object.defineProperty(navigator, 'language', { value: primary, configurable: true })
  })
  afterEach(() => {
    const own = navigator as unknown as Record<string, unknown>
    delete own.languages
    delete own.language
  })
}

export function stubSettingsScope<T>(): { scope: SettingsScope<T> } {
  const snapshot: SettingsScopeSnapshot<T> = {
    status: 'loading', value: undefined, base: undefined, user: undefined,
    revision: undefined, writable: false,
  }
  return { scope: {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    set: vi.fn(async () => true),
    mutate: vi.fn(async () => true),
    unset: vi.fn(async () => true),
  } }
}
