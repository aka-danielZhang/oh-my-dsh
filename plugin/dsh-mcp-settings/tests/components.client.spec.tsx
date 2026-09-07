// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { McpSettingsSection } from '../src/client/McpSettingsSection.tsx'
import type { McpSettingsSectionProps } from '../src/client/McpSettingsSection.tsx'
import { McpServersTab, draftFromJson } from '../src/client/McpServersTab.tsx'
import type { McpServerEntry } from '../src/client/drafts.ts'
import {
  argsFromText,
  blankDraft,
  draftFromEntry,
  mapFromText,
  mapToText,
  validateDrafts,
} from '../src/client/drafts.ts'
import { en, type McpSettingsLocaleKey } from '../src/client/locales.ts'
import type { McpInventorySnapshot } from '../src/inventory-types.ts'
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

type Translate = (key: McpSettingsLocaleKey, params?: Record<string, unknown>) => string
const t: Translate = (key, params) => {
  let text: string = en[key]
  for (const [name, value] of Object.entries(params ?? {})) text = text.replaceAll(`{${name}}`, String(value))
  return text
}

function fakeScope(value: { servers: McpServerEntry[] } | undefined, status: 'ready' | 'unavailable' = 'ready'): {
  scope: SettingsScope<{ servers: McpServerEntry[] }>
  set: ReturnType<typeof vi.fn>
  publish(next: SettingsScopeSnapshot<{ servers: McpServerEntry[] }>): void
} {
  const listeners = new Set<() => void>()
  const set = vi.fn((_field: string, _value: unknown) => Promise.resolve())
  let snapshot: SettingsScopeSnapshot<{ servers: McpServerEntry[] }> = {
    status,
    value,
    base: undefined,
    user: undefined,
    revision: 1,
    writable: status === 'ready',
    mode: 'host',
  }
  const scope = {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set: (field: string, next: unknown) => set(field, next),
    unset: vi.fn(() => Promise.resolve()),
  } as unknown as SettingsScope<{ servers: McpServerEntry[] }>
  return {
    scope,
    set,
    publish(next) {
      snapshot = next
      for (const listener of listeners) listener()
    },
  }
}

const STORED: McpServerEntry[] = [
  {
    transport: 'stdio',
    serverName: 'alpha',
    enabled: true,
    command: 'npx',
    args: ['-y', 'server-alpha'],
    env: { TOKEN: 'x' },
    envCredentialRefs: { API_TOKEN: 'ALPHA_KEY' },
    cwd: '/tmp',
    toolCallTimeoutMs: 60_000,
  },
  {
    transport: 'streamable-http',
    serverName: 'beta',
    enabled: false,
    url: 'http://localhost/mcp',
    headers: {},
    authorizationCredentialRef: 'BETA_KEY',
    toolCallTimeoutMs: 60_000,
  },
]

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const STATUS_SNAPSHOT: McpInventorySnapshot = {
  servers: [
    { serverName: 'alpha', transport: 'stdio', enabled: true, connection: 'connected', toolCount: 3 },
    { serverName: 'beta', transport: 'streamable-http', enabled: false, connection: null, toolCount: 0 },
  ],
}

const listStatus = () => Promise.resolve(STATUS_SNAPSHOT)

describe('McpSettingsSection', () => {
  it('renders the server manager without a separate status tab', async () => {
    const { scope } = fakeScope({ servers: STORED })
    const props = { scope, listStatus, t, close: () => {} } as unknown as McpSettingsSectionProps
    render(<McpSettingsSection {...props} />)
    expect(screen.getByRole('heading', { level: 2, name: en.title })).toBeTruthy()
    expect(screen.getByText(en.intro)).toBeTruthy()
    expect(screen.queryByRole('tablist')).toBeNull()
    expect(screen.getByText(en.addServer)).toBeTruthy()
    await waitFor(() => { expect(screen.getByRole('status', { name: en.connectionConnected })).toBeTruthy() })
    expect(screen.queryByText(en.connectionConnected)).toBeNull()
    expect(screen.getByText(t('toolCount', { count: '3' }))).toBeTruthy()
  })
})

describe('McpServersTab', () => {
  it('renders availability and loading notices', () => {
    const unavailable = fakeScope(undefined, 'unavailable')
    const view = render(<McpServersTab scope={unavailable.scope} listStatus={listStatus} t={t} />)
    expect(screen.getByText(en.writeUnavailable)).toBeTruthy()
    view.unmount()

    const loading = fakeScope(undefined)
    render(<McpServersTab scope={loading.scope} listStatus={listStatus} t={t} />)
    expect(screen.getByText(en.loadFailed)).toBeTruthy()
  })

  it('shows a searchable server list', async () => {
    const { scope } = fakeScope({ servers: STORED })
    render(<McpServersTab scope={scope} listStatus={listStatus} t={t} />)
    await waitFor(() => { expect(screen.getByText('alpha')).toBeTruthy() })
    expect(screen.getByText('beta')).toBeTruthy()
    expect(screen.getByText(t('serverCount', { count: '2' }))).toBeTruthy()

    fireEvent.change(screen.getByPlaceholderText(en.searchServers), { target: { value: 'server-alpha' } })
    expect(screen.getByText('alpha')).toBeTruthy()
    expect(screen.queryByText('beta')).toBeNull()
    fireEvent.change(screen.getByPlaceholderText(en.searchServers), { target: { value: 'missing' } })
    expect(screen.getByText(en.emptySearch)).toBeTruthy()
  })

  it('merges every live connection state into the list and retries a failed read', async () => {
    const entries: McpServerEntry[] = ['reconnecting', 'failed', 'disposed', 'pending', 'missing'].map(serverName => ({
      ...STORED[0]!, serverName,
    }))
    const recovered: McpInventorySnapshot = {
      servers: [
        { serverName: 'reconnecting', transport: 'stdio', enabled: true, connection: 'reconnecting', toolCount: 2 },
        { serverName: 'failed', transport: 'stdio', enabled: true, connection: 'failed', toolCount: 0 },
        { serverName: 'disposed', transport: 'stdio', enabled: true, connection: 'disposed', toolCount: 0 },
        { serverName: 'pending', transport: 'stdio', enabled: true, connection: null, toolCount: 0 },
      ],
    }
    const status = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(recovered)
    const { scope } = fakeScope({ servers: entries })
    render(<McpServersTab scope={scope} listStatus={status} t={t} />)
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe(en.statusLoadFailed) })
    expect(screen.getAllByRole('status', { name: en.connectionFailed })).toHaveLength(5)
    fireEvent.click(screen.getByRole('button', { name: en.refresh }))
    await waitFor(() => { expect(screen.getByRole('status', { name: en.connectionReconnecting })).toBeTruthy() })
    expect(screen.getByText(en.connectionFailed)).toBeTruthy()
    expect(screen.getByText(en.connectionDisposed)).toBeTruthy()
    expect(screen.getAllByRole('status', { name: en.connectionConnecting })).toHaveLength(2)
    expect(screen.queryByText(t('toolCount', { count: '2' }))).toBeNull()
  })

  it('disables status refresh while a read is pending', async () => {
    const pending = deferred<McpInventorySnapshot>()
    const { scope } = fakeScope({ servers: STORED })
    render(<McpServersTab scope={scope} listStatus={() => pending.promise} t={t} />)
    expect(screen.getByRole('button', { name: en.refresh })).toHaveProperty('disabled', true)
    pending.resolve(STATUS_SNAPSHOT)
    await waitFor(() => { expect(screen.getByRole('button', { name: en.refresh })).toHaveProperty('disabled', false) })
  })

  it('edits one server in the form and persists it', async () => {
    const { scope, set } = fakeScope({ servers: STORED })
    render(<McpServersTab scope={scope} listStatus={listStatus} t={t} />)
    await waitFor(() => { expect(screen.getAllByRole('button', { name: en.editServer })).toHaveLength(2) })
    fireEvent.click(screen.getAllByRole('button', { name: en.editServer })[0]!)
    fireEvent.change(screen.getByLabelText(en.command), { target: { value: 'node' } })
    fireEvent.change(screen.getByLabelText(en.args), { target: { value: 'server.js --quiet' } })
    fireEvent.change(screen.getByLabelText(en.env), { target: { value: '{"MODE":"test"}' } })
    fireEvent.change(screen.getByLabelText(en.envCredentialRefs), { target: { value: '{"API_TOKEN":"UPDATED_KEY"}' } })
    fireEvent.change(screen.getByLabelText(en.cwd), { target: { value: '/workspace' } })
    fireEvent.click(screen.getByRole('button', { name: en.save }))

    await waitFor(() => {
      expect(set).toHaveBeenCalledWith('servers', [
        expect.objectContaining({
          serverName: 'alpha', command: 'node', args: ['server.js', '--quiet'], env: { MODE: 'test' },
          envCredentialRefs: { API_TOKEN: 'UPDATED_KEY' }, cwd: '/workspace',
        }),
        STORED[1],
      ])
    })
    expect(screen.getByText(en.saved)).toBeTruthy()
  })

  it('creates an HTTP server with the form', async () => {
    const { scope, set } = fakeScope({ servers: [] })
    render(<McpServersTab scope={scope} listStatus={listStatus} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: en.addServer }))
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'http-one' } })
    const transport = screen.getByRole('button', { name: en.transport })
    expect(transport.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(transport)
    expect(transport.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(screen.getByRole('menuitem', { name: en.transportHttp }))
    expect(transport.textContent).toContain(en.transportHttp)
    expect(transport.getAttribute('aria-expanded')).toBe('false')
    fireEvent.change(screen.getByLabelText(/^URL/), { target: { value: 'http://one/mcp' } })
    fireEvent.change(screen.getByLabelText(en.headers), { target: { value: '{"X-Test":"present"}' } })
    fireEvent.change(screen.getByLabelText(en.authorizationCredentialRef), { target: { value: 'HTTP_KEY' } })
    fireEvent.click(screen.getByRole('button', { name: en.save }))

    await waitFor(() => {
      expect(set).toHaveBeenCalledWith('servers', [expect.objectContaining({
        transport: 'streamable-http', serverName: 'http-one', url: 'http://one/mcp',
        headers: { 'X-Test': 'present' }, authorizationCredentialRef: 'HTTP_KEY',
      })])
    })
  })

  it('marks blank stdio fields only after Save is requested', async () => {
    const { scope, set } = fakeScope({ servers: [] })
    render(<McpServersTab scope={scope} listStatus={listStatus} t={t} />)
    await waitFor(() => { expect(screen.getByRole('button', { name: en.addServer })).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: en.addServer }))
    const name = screen.getByLabelText(en.serverName)
    const command = screen.getByLabelText(en.command)
    expect(screen.getAllByText('*')).toHaveLength(2)
    expect(name.getAttribute('aria-invalid')).toBe('false')
    expect(command.getAttribute('aria-invalid')).toBe('false')
    expect(screen.queryByRole('alert')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    expect(screen.getByRole('alert').textContent).toBe(en.fixValidation)
    expect(name.getAttribute('aria-invalid')).toBe('true')
    expect(command.getAttribute('aria-invalid')).toBe('true')
    expect(set).not.toHaveBeenCalled()
  })

  it('creates a stdio server from JSON and can return to form mode', async () => {
    const { scope, set } = fakeScope({ servers: [] })
    render(<McpServersTab scope={scope} listStatus={listStatus} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: en.addServer }))
    fireEvent.click(screen.getByRole('tab', { name: en.jsonMode }))
    const json = JSON.stringify({ gamma: { type: 'stdio', command: 'npx', args: ['-y', 'gamma'], env: { A: '1' }, enabled: false } }, null, 2)
    fireEvent.change(screen.getByLabelText(en.fullConfiguration), { target: { value: json } })
    fireEvent.click(screen.getByRole('tab', { name: en.formMode }))
    expect(screen.getByLabelText(en.serverName)).toHaveProperty('value', 'gamma')
    fireEvent.click(screen.getByRole('tab', { name: en.jsonMode }))
    fireEvent.click(screen.getByRole('button', { name: en.save }))

    await waitFor(() => {
      expect(set).toHaveBeenCalledWith('servers', [expect.objectContaining({
        transport: 'stdio', serverName: 'gamma', command: 'npx', args: ['-y', 'gamma'], env: { A: '1' }, enabled: false,
      })])
    })
  })

  it('rejects invalid JSON, invalid maps, required fields, and duplicate names', async () => {
    const { scope, set } = fakeScope({ servers: STORED })
    render(<McpServersTab scope={scope} listStatus={listStatus} t={t} />)
    await waitFor(() => { expect(screen.getAllByRole('button', { name: en.editServer })).toHaveLength(2) })
    fireEvent.click(screen.getAllByRole('button', { name: en.editServer })[1]!)
    const url = screen.getByLabelText(en.url)
    fireEvent.change(url, { target: { value: '' } })
    expect(screen.getAllByText('*')).toHaveLength(2)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(url.getAttribute('aria-invalid')).toBe('false')
    fireEvent.change(screen.getByLabelText(en.serverName), { target: { value: 'alpha' } })
    expect(screen.queryByText(en.duplicate)).toBeNull()
    fireEvent.change(screen.getByLabelText(en.headers), { target: { value: '{bad' } })
    expect(screen.getByText(en.invalidJson)).toBeTruthy()
    const save = screen.getByRole('button', { name: en.save })
    expect(save).toHaveProperty('disabled', false)
    fireEvent.click(save)
    expect(screen.getByRole('alert').textContent).toBe(en.fixValidation)
    expect(screen.getByText(en.duplicate)).toBeTruthy()
    expect(url.getAttribute('aria-invalid')).toBe('true')

    fireEvent.click(screen.getByRole('tab', { name: en.jsonMode }))
    fireEvent.change(screen.getByLabelText(en.fullConfiguration), { target: { value: '{oops' } })
    expect(screen.getByText(en.invalidServerJson)).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: en.formMode }))
    expect(screen.getByRole('tab', { name: en.jsonMode, selected: true })).toBeTruthy()
    expect(screen.getByRole('button', { name: en.save })).toHaveProperty('disabled', false)
    expect(set).not.toHaveBeenCalled()
  })

  it('polls an initially connecting server and stops when it connects', async () => {
    vi.useFakeTimers()
    const connecting: McpInventorySnapshot = {
      servers: [
        { serverName: 'alpha', transport: 'stdio', enabled: true, connection: 'connecting', toolCount: 0 },
        STATUS_SNAPSHOT.servers[1]!,
      ],
    }
    const status = vi.fn()
      .mockResolvedValueOnce(connecting)
      .mockResolvedValue(STATUS_SNAPSHOT)
    const { scope } = fakeScope({ servers: STORED })
    render(<McpServersTab scope={scope} listStatus={status} t={t} />)
    await act(async () => { await Promise.resolve() })

    expect(status).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('status', { name: en.connectionConnecting })).toBeTruthy()
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })
    expect(status).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('status', { name: en.connectionConnected })).toBeTruthy()

    await act(async () => { await vi.advanceTimersByTimeAsync(4_000) })
    expect(status).toHaveBeenCalledTimes(2)
  })

  it('waits for a silent poll and ignores its stale result after a manual refresh', async () => {
    vi.useFakeTimers()
    const connecting: McpInventorySnapshot = {
      servers: [
        { serverName: 'alpha', transport: 'stdio', enabled: true, connection: 'connecting', toolCount: 0 },
        STATUS_SNAPSHOT.servers[1]!,
      ],
    }
    const slowPoll = deferred<McpInventorySnapshot>()
    const status = vi.fn()
      .mockResolvedValueOnce(connecting)
      .mockReturnValueOnce(slowPoll.promise)
      .mockResolvedValue(STATUS_SNAPSHOT)
    const { scope } = fakeScope({ servers: STORED })
    render(<McpServersTab scope={scope} listStatus={status} t={t} />)
    await act(async () => { await Promise.resolve() })

    await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })
    expect(status).toHaveBeenCalledTimes(2)
    await act(async () => { await vi.advanceTimersByTimeAsync(6_000) })
    expect(status).toHaveBeenCalledTimes(2)

    fireEvent.click(screen.getByRole('button', { name: en.refresh }))
    await act(async () => { await Promise.resolve() })
    expect(status).toHaveBeenCalledTimes(3)
    expect(screen.getByRole('status', { name: en.connectionConnected })).toBeTruthy()

    await act(async () => { slowPoll.reject(new Error('stale offline')); await Promise.resolve() })
    expect(screen.queryByText(en.statusLoadFailed)).toBeNull()
    expect(screen.getByRole('status', { name: en.connectionConnected })).toBeTruthy()
  })

  it('polls after enabling and stops when the server connects', async () => {
    vi.useFakeTimers()
    const connecting: McpInventorySnapshot = {
      servers: [
        STATUS_SNAPSHOT.servers[0]!,
        { serverName: 'beta', transport: 'streamable-http', enabled: true, connection: 'connecting', toolCount: 0 },
      ],
    }
    const connected: McpInventorySnapshot = {
      servers: [
        STATUS_SNAPSHOT.servers[0]!,
        { serverName: 'beta', transport: 'streamable-http', enabled: true, connection: 'connected', toolCount: 4 },
      ],
    }
    const status = vi.fn()
      .mockResolvedValueOnce(STATUS_SNAPSHOT)
      .mockResolvedValueOnce(connecting)
      .mockResolvedValue(connected)
    const { scope } = fakeScope({ servers: STORED })
    render(<McpServersTab scope={scope} listStatus={status} t={t} />)
    await act(async () => { await Promise.resolve() })

    await act(async () => {
      fireEvent.click(screen.getByLabelText(t('toggleServer', { name: 'beta' })))
      await Promise.resolve()
    })
    expect(status).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('status', { name: en.connectionConnecting })).toBeTruthy()
    expect(screen.queryByText(t('toolCount', { count: '0' }))).toBeNull()

    await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })
    expect(status).toHaveBeenCalledTimes(3)
    expect(screen.getAllByRole('status', { name: en.connectionConnected })).toHaveLength(2)
    expect(screen.queryByText(en.connectionConnected)).toBeNull()
    expect(screen.getByText(t('toolCount', { count: '4' }))).toBeTruthy()

    await act(async () => { await vi.advanceTimersByTimeAsync(4_000) })
    expect(status).toHaveBeenCalledTimes(3)
  })

  it('stops connection polling after the sixty-second limit', async () => {
    vi.useFakeTimers()
    const connecting: McpInventorySnapshot = {
      servers: [
        STATUS_SNAPSHOT.servers[0]!,
        { serverName: 'beta', transport: 'streamable-http', enabled: true, connection: 'connecting', toolCount: 0 },
      ],
    }
    const status = vi.fn().mockResolvedValue(connecting)
    const { scope } = fakeScope({ servers: STORED })
    render(<McpServersTab scope={scope} listStatus={status} t={t} />)
    await act(async () => { await Promise.resolve() })
    await act(async () => {
      fireEvent.click(screen.getByLabelText(t('toggleServer', { name: 'beta' })))
      await Promise.resolve()
    })

    for (let attempt = 0; attempt < 30; attempt += 1) {
      await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })
    }
    expect(status).toHaveBeenCalledTimes(32)
    await act(async () => { await vi.advanceTimersByTimeAsync(4_000) })
    expect(status).toHaveBeenCalledTimes(32)
  })

  it('toggles and removes servers directly from the list', async () => {
    const { scope, set } = fakeScope({ servers: STORED })
    render(<McpServersTab scope={scope} listStatus={listStatus} t={t} />)
    await waitFor(() => { expect(screen.getByLabelText(t('toggleServer', { name: 'alpha' }))).toBeTruthy() })
    fireEvent.click(screen.getByLabelText(t('toggleServer', { name: 'alpha' })))
    await waitFor(() => {
      expect(set).toHaveBeenLastCalledWith('servers', [expect.objectContaining({ enabled: false }), STORED[1]])
    })
    fireEvent.click(screen.getAllByRole('button', { name: en.removeServer })[0]!)
    await waitFor(() => { expect(set).toHaveBeenLastCalledWith('servers', [STORED[1]]) })
  })

  it('validates stdio environment and credential-reference maps independently', async () => {
    const { scope } = fakeScope({ servers: STORED })
    render(<McpServersTab scope={scope} listStatus={listStatus} t={t} />)
    await waitFor(() => { expect(screen.getAllByRole('button', { name: en.editServer })).toHaveLength(2) })
    fireEvent.click(screen.getAllByRole('button', { name: en.editServer })[0]!)
    const env = screen.getByLabelText(en.env)
    const refs = screen.getByLabelText(en.envCredentialRefs)
    fireEvent.change(env, { target: { value: '{bad' } })
    expect(screen.getByText(en.invalidJson)).toBeTruthy()
    expect(env.getAttribute('aria-invalid')).toBe('true')
    expect(refs.getAttribute('aria-invalid')).toBe('false')

    fireEvent.change(env, { target: { value: '{}' } })
    fireEvent.change(refs, { target: { value: '{"API_KEY":"bad-ref"}' } })
    expect(screen.getByText(en.invalidCredentialRef)).toBeTruthy()
    expect(env.getAttribute('aria-invalid')).toBe('false')
    expect(refs.getAttribute('aria-invalid')).toBe('true')
  })

  it('shows the saving label only while a slow write is pending', async () => {
    vi.useFakeTimers()
    const pending = deferred<void>()
    const { scope, set } = fakeScope({ servers: STORED })
    set.mockReturnValueOnce(pending.promise)
    render(<McpServersTab scope={scope} listStatus={listStatus} t={t} />)
    await act(async () => { await Promise.resolve() })
    fireEvent.click(screen.getAllByRole('button', { name: en.editServer })[0]!)
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    expect(screen.getByRole('status', { name: en.connectionConnecting })).toBeTruthy()
    expect(screen.queryByText(t('toolCount', { count: '3' }))).toBeNull()
    // The label holds back past the fast-save window instead of flashing.
    expect(screen.queryByText(en.saving)).toBeNull()
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })
    expect(screen.getByText(en.saving)).toBeTruthy()
    await act(async () => { pending.resolve(); await Promise.resolve() })
    expect(screen.getByText(en.saved)).toBeTruthy()
    // The saved notice clears itself after the hold window.
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })
    expect(screen.queryByText(en.saved)).toBeNull()
  })

  it('registers overlapping writes immediately and lets only the latest write own the notice', async () => {
    vi.useFakeTimers()
    const first = deferred<void>()
    const second = deferred<void>()
    const { scope, set } = fakeScope({ servers: STORED })
    set.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    render(<McpServersTab scope={scope} listStatus={listStatus} t={t} />)
    await act(async () => { await Promise.resolve() })

    fireEvent.click(screen.getByLabelText(t('toggleServer', { name: 'alpha' })))
    fireEvent.click(screen.getAllByRole('button', { name: en.removeServer })[1]!)
    await act(async () => { await Promise.resolve() })
    expect(set).toHaveBeenCalledTimes(2)
    expect(set.mock.calls[0]?.[1]).not.toEqual(set.mock.calls[1]?.[1])

    await act(async () => { await vi.advanceTimersByTimeAsync(300) })
    expect(screen.getByText(en.saving)).toBeTruthy()
    await act(async () => { first.resolve(); await Promise.resolve(); await Promise.resolve() })
    expect(set).toHaveBeenCalledTimes(2)
    expect(screen.getByText(en.saving)).toBeTruthy()
    expect(screen.queryByText(en.saved)).toBeNull()

    await act(async () => { second.reject(new Error('latest failed')); await Promise.resolve() })
    expect(screen.getByRole('alert').textContent).toContain(en.saveFailed.split(':')[0])
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })
    expect(screen.getByRole('alert').textContent).toContain(en.saveFailed.split(':')[0])
  })

  it('supports cancel and back without writing', async () => {
    const { scope, set } = fakeScope({ servers: STORED })
    render(<McpServersTab scope={scope} listStatus={listStatus} t={t} />)
    await waitFor(() => { expect(screen.getAllByRole('button', { name: en.editServer })).toHaveLength(2) })
    fireEvent.click(screen.getAllByRole('button', { name: en.editServer })[0]!)
    fireEvent.click(screen.getByRole('button', { name: en.cancel }))
    fireEvent.click(screen.getAllByRole('button', { name: en.editServer })[0]!)
    fireEvent.click(screen.getByRole('button', { name: en.back }))
    expect(set).not.toHaveBeenCalled()
  })

  it('surfaces a failed direct write', async () => {
    const { scope, set } = fakeScope({ servers: STORED })
    set.mockRejectedValueOnce(new Error('write rejected'))
    render(<McpServersTab scope={scope} listStatus={listStatus} t={t} />)
    await waitFor(() => { expect(screen.getAllByRole('button', { name: en.removeServer })).toHaveLength(2) })
    fireEvent.click(screen.getAllByRole('button', { name: en.removeServer })[0]!)
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toContain(en.saveFailed.split(':')[0]) })
  })

  it('hydrates a later Host snapshot', async () => {
    const fixture = fakeScope({ servers: STORED })
    render(<McpServersTab scope={fixture.scope} listStatus={listStatus} t={t} />)
    await waitFor(() => { expect(screen.getByText('alpha')).toBeTruthy() })
    fixture.publish({
      status: 'ready', value: { servers: STORED.slice(1) }, base: undefined,
      user: undefined, revision: 2, writable: true, mode: 'host',
    })
    await waitFor(() => { expect(screen.queryByText('alpha')).toBeNull() })
    expect(screen.getByText('beta')).toBeTruthy()
  })

  it('shows the empty notice when no server is configured', () => {
    const { scope } = fakeScope({ servers: [] })
    render(<McpServersTab scope={scope} listStatus={listStatus} t={t} />)
    expect(screen.getByText(en.emptyServers)).toBeTruthy()
  })
})

describe('JSON editor parser', () => {
  const parse = (value: unknown) => draftFromJson(typeof value === 'string' ? value : JSON.stringify(value) ?? '', 'draft-key')

  it('accepts both transports and applies optional-field defaults', () => {
    expect(parse({ stdio: { type: 'stdio', command: 'node', envCredentialRefs: { API_KEY: 'TEST_KEY' } } })).toMatchObject({
      key: 'draft-key', serverName: 'stdio', transport: 'stdio', enabled: true,
      command: 'node', args: '', env: '',
      envCredentialRefs: JSON.stringify({ API_KEY: 'TEST_KEY' }, null, 2), cwd: '',
    })
    expect(parse({ http: { type: null, transport: 'streamable-http', url: 'https://example.test/mcp' } })).toMatchObject({
      serverName: 'http', transport: 'streamable-http', enabled: true,
      url: 'https://example.test/mcp', headers: '',
    })
    expect(parse({ http: {
      type: 'streamable-http', url: 'x', headers: { 'X-Test': 'present' },
      authorizationCredentialRef: 'HTTP_KEY', enabled: false,
    } })).toMatchObject({
      enabled: false, headers: JSON.stringify({ 'X-Test': 'present' }, null, 2),
      authorizationCredentialRef: 'HTTP_KEY',
    })
  })

  it('rejects invalid document and row containers', () => {
    for (const value of ['{bad', '"text"', null, [], 1, {}, { one: {}, two: {} }, { one: null }, { one: [] }, { one: 'bad' }]) {
      expect(parse(value)).toBeNull()
    }
  })

  it('rejects invalid stdio fields', () => {
    const invalid = [
      { type: 'stdio' },
      { type: 'stdio', command: 'x', args: 'bad' },
      { type: 'stdio', command: 'x', args: ['ok', 1] },
      { type: 'stdio', command: 'x', env: null },
      { type: 'stdio', command: 'x', env: [] },
      { type: 'stdio', command: 'x', env: 'bad' },
      { type: 'stdio', command: 'x', env: { KEY: 1 } },
      { type: 'stdio', command: 'x', envCredentialRefs: { API_KEY: 'bad-ref' } },
      { type: 'stdio', command: 'x', envCredentialRefs: { API_KEY: 1 } },
      { type: 'stdio', command: 'x', cwd: 1 },
    ]
    for (const config of invalid) expect(parse({ one: config })).toBeNull()
  })

  it('rejects invalid HTTP fields and unknown transports', () => {
    expect(parse({ one: { type: 'streamable-http' } })).toBeNull()
    expect(parse({ one: { type: 'streamable-http', url: 'x', headers: { KEY: 1 } } })).toBeNull()
    expect(parse({ one: { type: 'streamable-http', url: 'x', authorizationCredentialRef: 'bad-ref' } })).toBeNull()
    expect(parse({ one: { type: 'streamable-http', url: 'x', authorizationCredentialRef: 1 } })).toBeNull()
    expect(parse({ one: { type: 'unknown', url: 'x' } })).toBeNull()
  })
})

describe('drafts helpers', () => {
  it('round-trips a map field through text', () => {
    const text = mapToText({ A: '1' })
    expect(text).toBe(JSON.stringify({ A: '1' }, null, 2))
    expect(mapFromText(text)).toEqual({ value: { A: '1' } })
    expect(mapFromText('')).toEqual({ value: {} })
    const invalidJson = mapFromText('{bad')
    expect('error' in invalidJson && invalidJson.error).toBe('invalidJson')
    const invalidShape = mapFromText('[1]')
    expect('error' in invalidShape && invalidShape.error).toBe('invalidShape')
    const invalidValue = mapFromText('{"k":1}')
    expect('error' in invalidValue && invalidValue.error).toBe('invalidValue')
  })

  it('splits whitespace-separated args', () => {
    expect(argsFromText('')).toEqual([])
    expect(argsFromText(' -y   server ')).toEqual(['-y', 'server'])
  })

  it('projects stored entries into drafts', () => {
    const draft = draftFromEntry(STORED[0]!, 'k1')
    expect(draft.command).toBe('npx')
    expect(draft.args).toBe('-y server-alpha')
    expect(draft.envCredentialRefs).toBe(JSON.stringify({ API_TOKEN: 'ALPHA_KEY' }, null, 2))
    const http = draftFromEntry(STORED[1]!, 'k2')
    expect(http.url).toBe('http://localhost/mcp')
    expect(http.authorizationCredentialRef).toBe('BETA_KEY')
    expect(blankDraft().transport).toBe('stdio')
  })

  it('validates required fields and transport-specific gaps', () => {
    const issues = validateDrafts([{ ...blankDraft(), serverName: '', transport: 'stdio', command: '' }])
    expect([...issues.values()][0]!.fields).toEqual({ serverName: 'required', command: 'required' })
    const http = validateDrafts([{
      ...blankDraft(), serverName: 'x', transport: 'streamable-http', url: '',
      authorizationCredentialRef: 'bad-ref',
    }])
    expect([...http.values()][0]!.fields).toEqual({ url: 'required', authorizationCredentialRef: 'invalidCredentialRef' })
    const first = { ...blankDraft(), key: 'first', serverName: 'same', command: '' }
    const duplicate = { ...blankDraft(), key: 'second', serverName: 'same', transport: 'streamable-http' as const, url: '' }
    const duplicateIssues = validateDrafts([first, duplicate])
    expect(duplicateIssues.get('first')?.fields).toEqual({ command: 'required' })
    expect(duplicateIssues.get('second')?.fields).toEqual({ serverName: 'duplicate', url: 'required' })
  })
})
