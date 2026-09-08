import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { McpInventorySnapshot, McpServerStatus } from '../inventory-types.ts'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import {
  Button,
  IconChevronDownOutline14,
  IconChevronLeftOutline14,
  IconCodeOutline16,
  IconEditOutline16,
  IconGlobeOutline14,
  IconLoadingOutline16,
  IconPlusOutline16,
  IconRefreshOutline16,
  IconSearchOutline16,
  IconTrashOutline16,
  Menu,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateSection } from './McpSettingsSection.tsx'
import type { McpSettingsLocaleKey } from './locales.ts'
import {
  argsFromText,
  type McpServerEntry,
  blankDraft,
  draftFromEntry,
  isCredentialRef,
  mapFromText,
  type McpServerDraft,
  validateDrafts,
} from './drafts.ts'
import css from './McpSettingsSection.module.css'

type SaveNotice = 'saving' | 'saved' | 'failed'
type EditorMode = 'form' | 'json'

const CONNECTION_POLL_INTERVAL_MS = 2_000
const CONNECTION_POLL_LIMIT = 30
// Fast saves skip the "saving" label entirely — flashing it for a sub-300ms
// roundtrip reads as a glitch, not feedback; "saved" holds briefly then clears.
const SAVE_NOTICE_DELAY_MS = 300
const SAVE_NOTICE_HOLD_MS = 2_000

interface EditorState {
  readonly index: number | null
  readonly draft: McpServerDraft
  readonly mode: EditorMode
  readonly json: string
  readonly attempted: boolean
}

const CONNECTION_KEYS = {
  connecting: 'connectionConnecting',
  connected: 'connectionConnected',
  reconnecting: 'connectionReconnecting',
  failed: 'connectionFailed',
  disposed: 'connectionDisposed',
} satisfies Record<Exclude<McpServerStatus['connection'], null>, McpSettingsLocaleKey>

function connectionLabel(server: McpServerEntry, status: McpServerStatus | undefined, t: TranslateSection): string {
  if (!server.enabled) return t('connectionDisabled')
  if (status?.connection == null) return t('connectionConnecting')
  return t(CONNECTION_KEYS[status.connection])
}

function validMap(text: string): Record<string, string> {
  const parsed = mapFromText(text)
  return 'value' in parsed ? parsed.value : {}
}

function mapIssue(text: string, credentialRefs = false): McpSettingsLocaleKey | undefined {
  const parsed = mapFromText(text)
  if ('error' in parsed) return parsed.error === 'invalidJson' ? 'invalidJson' : 'invalidShape'
  if (credentialRefs && Object.values(parsed.value).some(ref => !isCredentialRef(ref))) return 'invalidCredentialRef'
  return undefined
}

function entryFromDraft(draft: McpServerDraft): McpServerEntry {
  const shared = { serverName: draft.serverName.trim(), enabled: draft.enabled, toolCallTimeoutMs: 60_000 }
  return draft.transport === 'stdio'
    ? {
      transport: 'stdio',
      ...shared,
      command: draft.command.trim(),
      args: argsFromText(draft.args),
      env: validMap(draft.env),
      envCredentialRefs: validMap(draft.envCredentialRefs),
      cwd: draft.cwd.trim(),
    }
    : {
      transport: 'streamable-http',
      ...shared,
      url: draft.url.trim(),
      headers: validMap(draft.headers),
      ...draft.authorizationCredentialRef.trim() === ''
        ? {}
        : { authorizationCredentialRef: draft.authorizationCredentialRef.trim() },
    }
}

function jsonFromDraft(draft: McpServerDraft): string {
  const name = draft.serverName.trim() || 'my-mcp-server'
  const config = draft.transport === 'stdio'
    ? {
      type: 'stdio',
      command: draft.command,
      args: argsFromText(draft.args),
      env: validMap(draft.env),
      envCredentialRefs: validMap(draft.envCredentialRefs),
      cwd: draft.cwd,
      enabled: draft.enabled,
    }
    : {
      type: 'streamable-http',
      url: draft.url,
      headers: validMap(draft.headers),
      ...draft.authorizationCredentialRef.trim() === ''
        ? {}
        : { authorizationCredentialRef: draft.authorizationCredentialRef.trim() },
      enabled: draft.enabled,
    }
  return JSON.stringify({ [name]: config }, null, 2)
}

/** Parse one-server JSON editor text into a form draft.
 * @param text - complete one-server MCP JSON object.
 * @param key - stable draft identity retained across editor modes.
 * @returns the parsed draft, or null when the document is not a supported one-server configuration.
 */
export function draftFromJson(text: string, key: string): McpServerDraft | null {
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    const rows = Object.entries(parsed)
    if (rows.length !== 1) return null
    const [serverName, raw] = rows[0]!
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
    const config = raw as Record<string, unknown>
    const type = config.type ?? config.transport
    const enabled = typeof config.enabled === 'boolean' ? config.enabled : true
    if (type === 'stdio') {
      if (typeof config.command !== 'string') return null
      if (config.args !== undefined && (!Array.isArray(config.args) || config.args.some(value => typeof value !== 'string'))) return null
      if (config.env !== undefined && !isStringMap(config.env)) return null
      if (config.envCredentialRefs !== undefined && (
        !isStringMap(config.envCredentialRefs)
        || Object.values(config.envCredentialRefs).some(ref => !isCredentialRef(ref))
      )) return null
      if (config.cwd !== undefined && typeof config.cwd !== 'string') return null
      return {
        ...blankDraft(), key, serverName, transport: 'stdio', enabled,
        command: config.command,
        args: Array.isArray(config.args) ? config.args.join(' ') : '',
        env: config.env === undefined ? '' : JSON.stringify(config.env, null, 2),
        envCredentialRefs: config.envCredentialRefs === undefined ? '' : JSON.stringify(config.envCredentialRefs, null, 2),
        cwd: typeof config.cwd === 'string' ? config.cwd : '',
      }
    }
    if (type === 'streamable-http') {
      if (typeof config.url !== 'string') return null
      if (config.headers !== undefined && !isStringMap(config.headers)) return null
      if (config.authorizationCredentialRef !== undefined && (
        typeof config.authorizationCredentialRef !== 'string'
        || !isCredentialRef(config.authorizationCredentialRef)
      )) return null
      return {
        ...blankDraft(), key, serverName, transport: 'streamable-http', enabled,
        url: config.url,
        headers: config.headers === undefined ? '' : JSON.stringify(config.headers, null, 2),
        authorizationCredentialRef: typeof config.authorizationCredentialRef === 'string' ? config.authorizationCredentialRef : '',
      }
    }
    return null
  } catch {
    return null
  }
}

function isStringMap(value: unknown): value is Record<string, string> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.values(value).every(item => typeof item === 'string')
}

function summary(entry: McpServerEntry): string {
  return entry.transport === 'stdio'
    ? [entry.command, ...entry.args].join(' ')
    : entry.url
}

/** List, create, edit, toggle, delete, and inspect settings-owned MCP servers. */
export function McpServersTab(props: {
  scope: SettingsScope<{ servers: McpServerEntry[] }>
  listStatus: () => Promise<McpInventorySnapshot>
  t: TranslateSection
}): ReactNode {
  const { scope, listStatus, t } = props
  const snapshot = useSyncExternalStore(scope.subscribe.bind(scope), scope.getSnapshot.bind(scope))
  const [servers, setServers] = useState<McpServerEntry[]>([])
  const [hydratedFrom, setHydratedFrom] = useState<object | undefined>()
  const [query, setQuery] = useState('')
  const [saveNotice, setSaveNotice] = useState<SaveNotice | null>(null)
  const saveTimersRef = useRef<{ show: ReturnType<typeof setTimeout> | undefined, hide: ReturnType<typeof setTimeout> | undefined }>({ show: undefined, hide: undefined })
  const saveRevisionRef = useRef(0)
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [inventory, setInventory] = useState<McpInventorySnapshot | null>(null)
  const [statusLoading, setStatusLoading] = useState(true)
  const [statusFailed, setStatusFailed] = useState(false)
  const statusRequestRef = useRef(0)
  const [connectionPollsRemaining, setConnectionPollsRemaining] = useState(CONNECTION_POLL_LIMIT)
  const [transportMenuOpen, setTransportMenuOpen] = useState(false)

  // Silent fetches skip the loading flag: polls and post-save refreshes must
  // not churn the whole list (spinner swaps, disabled refresh button) — only
  // the rows whose live state actually changed should re-render.
  const fetchStatus = useCallback((silent: boolean): Promise<void> => {
    const request = ++statusRequestRef.current
    if (!silent) {
      setStatusLoading(true)
      setStatusFailed(false)
    }
    return listStatus().then(
      (next) => {
        if (statusRequestRef.current !== request) return
        setInventory(next)
        setStatusFailed(false)
        setStatusLoading(false)
      },
      () => {
        if (statusRequestRef.current !== request) return
        setStatusFailed(true)
        setStatusLoading(false)
      },
    )
  }, [listStatus])

  const refreshStatus = useCallback((): void => { fetchStatus(false) }, [fetchStatus])

  useEffect(() => { refreshStatus() }, [refreshStatus])

  useEffect(() => {
    if (snapshot.value === undefined || hydratedFrom === snapshot.value) return
    setHydratedFrom(snapshot.value)
    setServers([...snapshot.value.servers])
  }, [hydratedFrom, snapshot.value])

  const waitingForConnection = servers.some((server) => {
    if (!server.enabled) return false
    return inventory?.servers.find(item => item.serverName === server.serverName)?.connection !== 'connected'
  })

  useEffect(() => {
    if (!waitingForConnection || statusLoading || connectionPollsRemaining === 0) return
    let active = true
    const timer = setTimeout(() => {
      void fetchStatus(true).finally(() => {
        if (active) setConnectionPollsRemaining(remaining => remaining - 1)
      })
    }, CONNECTION_POLL_INTERVAL_MS)
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [connectionPollsRemaining, fetchStatus, statusLoading, waitingForConnection])

  useEffect(() => {
    const timers = saveTimersRef.current
    return () => {
      clearTimeout(timers.show)
      clearTimeout(timers.hide)
    }
  }, [])

  const persist = (next: McpServerEntry[], awaitConnection = false): void => {
    setServers(next)
    const unchangedNames = new Set(next.filter(entry => servers.includes(entry)).map(entry => entry.serverName))
    setInventory(current => current === null
      ? null
      : { ...current, servers: current.servers.filter(entry => unchangedNames.has(entry.serverName)) })
    const revision = ++saveRevisionRef.current
    const timers = saveTimersRef.current
    clearTimeout(timers.show)
    clearTimeout(timers.hide)
    setSaveNotice(null)
    timers.show = setTimeout(() => { setSaveNotice('saving') }, SAVE_NOTICE_DELAY_MS)
    // Preserve live state only for unchanged rows. The edited or enabled row
    // has no inventory entry until the Host reports its new connection, so it
    // renders as connecting without churning unrelated rows.
    if (awaitConnection) setConnectionPollsRemaining(0)
    // SettingsScope owns write serialization and suppresses stale Host
    // publications, so every optimistic write must be registered immediately.
    const request = scope.set('servers', next)
    void request.then(
      () => {
        if (saveRevisionRef.current !== revision) return
        clearTimeout(timers.show)
        setSaveNotice('saved')
        timers.hide = setTimeout(() => { setSaveNotice(null) }, SAVE_NOTICE_HOLD_MS)
        if (awaitConnection) setConnectionPollsRemaining(CONNECTION_POLL_LIMIT)
        void fetchStatus(true)
      },
      () => {
        if (saveRevisionRef.current !== revision) return
        clearTimeout(timers.show)
        setConnectionPollsRemaining(0)
        setSaveNotice('failed')
      },
    )
  }

  if (snapshot.status === 'unavailable') return <p className={css.status}>{t('writeUnavailable')}</p>
  if (snapshot.value === undefined) return <p className={css.status}>{t('loadFailed')}</p>

  if (editor !== null) {
    const parsedJson = editor.mode === 'json' ? draftFromJson(editor.json, editor.draft.key) : editor.draft
    const draft = parsedJson ?? editor.draft
    const validationRows = servers
      .filter((_server, index) => index !== editor.index)
      .map((entry, index) => draftFromEntry(entry, `existing-${index}`))
    validationRows.push(draft)
    const issues = validateDrafts(validationRows).get(draft.key)
    const envIssue = draft.transport === 'stdio' ? mapIssue(draft.env) : undefined
    const envCredentialRefsIssue = draft.transport === 'stdio' ? mapIssue(draft.envCredentialRefs, true) : undefined
    const headersIssue = draft.transport === 'streamable-http' ? mapIssue(draft.headers) : undefined
    const mapInvalid = envIssue !== undefined || envCredentialRefsIssue !== undefined || headersIssue !== undefined
    const invalid = parsedJson === null || issues !== undefined || mapInvalid
    const update = (patch: Partial<McpServerDraft>): void => {
      const nextDraft = { ...editor.draft, ...patch }
      setEditor({ ...editor, draft: nextDraft, json: jsonFromDraft(nextDraft) })
    }
    const selectMode = (mode: EditorMode): void => {
      if (mode === 'form') {
        const nextDraft = draftFromJson(editor.json, editor.draft.key)
        if (nextDraft === null) return
        setEditor({ ...editor, mode, draft: nextDraft })
      } else {
        setEditor({ ...editor, mode, json: jsonFromDraft(editor.draft) })
      }
    }
    const submit = (): void => {
      if (invalid) {
        setEditor({ ...editor, attempted: true })
        return
      }
      const next = [...servers]
      const entry = entryFromDraft(draft)
      if (editor.index === null) next.push(entry)
      else next[editor.index] = entry
      persist(next, entry.enabled)
      setEditor(null)
    }

    return (
      <div className={css.editor}>
        <div className={css.editorHeader}>
          <button type="button" className={css.back} onClick={() => { setEditor(null) }}>
            <IconChevronLeftOutline14 size={14} />
            {t('back')}
          </button>
          <div className={css.editorHeading}>
            <div>
              <h3>{editor.index === null ? t('createTitle') : t('editTitle')}</h3>
              <p>{editor.index === null ? t('createDescription') : t('editDescription')}</p>
            </div>
            <div className={css.segmented} role="tablist" aria-label={t('editorMode')}>
              <button type="button" role="tab" aria-selected={editor.mode === 'form'} onClick={() => { selectMode('form') }}>{t('formMode')}</button>
              <button type="button" role="tab" aria-selected={editor.mode === 'json'} onClick={() => { selectMode('json') }}>{t('jsonMode')}</button>
            </div>
          </div>
        </div>

        {editor.mode === 'json' ? (
          <label className={css.jsonField}>
            <span>{t('fullConfiguration')}</span>
            <textarea value={editor.json} spellCheck={false} aria-invalid={parsedJson === null} onChange={(event) => { setEditor({ ...editor, json: event.currentTarget.value }) }} />
            {parsedJson === null ? <em>{t('invalidServerJson')}</em> : null}
          </label>
        ) : (
          <div className={css.formSurface}>
            <div className={css.formTopRow}>
              <label className={css.field}>
                <span>{t('serverName')}<b className={css.requiredMark} aria-hidden="true">*</b></span>
                <input required aria-label={t('serverName')} value={editor.draft.serverName} aria-invalid={editor.attempted && issues?.fields.serverName !== undefined} onChange={(event) => { update({ serverName: event.currentTarget.value }) }} />
                {editor.attempted && issues?.fields.serverName === 'duplicate' ? <em>{t('duplicate')}</em> : null}
              </label>
              <div className={css.field}>
                <span>{t('transport')}</span>
                <Menu
                  open={transportMenuOpen}
                  portal
                  compact
                  className={css.transportMenu!}
                  selectedId={editor.draft.transport}
                  items={[
                    { id: 'stdio', label: t('transportStdio'), icon: <IconCodeOutline16 size={14} /> },
                    { id: 'streamable-http', label: t('transportHttp'), icon: <IconGlobeOutline14 size={14} /> },
                  ]}
                  onClose={() => { setTransportMenuOpen(false) }}
                  onSelect={(id) => {
                    update({ transport: id as McpServerDraft['transport'] })
                    setTransportMenuOpen(false)
                  }}
                  anchor={(
                    <button
                      type="button"
                      className={css.transportTrigger}
                      aria-label={t('transport')}
                      aria-haspopup="menu"
                      aria-expanded={transportMenuOpen}
                      onClick={() => { setTransportMenuOpen(open => !open) }}
                      onKeyDown={(event) => {
                        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
                        event.preventDefault()
                        setTransportMenuOpen(true)
                      }}
                    >
                      <span className={css.transportIcon} aria-hidden="true">
                        {editor.draft.transport === 'stdio' ? <IconCodeOutline16 size={14} /> : <IconGlobeOutline14 size={14} />}
                      </span>
                      <span className={css.transportValue}>
                        {editor.draft.transport === 'stdio' ? t('transportStdio') : t('transportHttp')}
                      </span>
                      <IconChevronDownOutline14 className={css.transportChevron} size={14} />
                    </button>
                  )}
                />
              </div>
            </div>
            {editor.draft.transport === 'stdio' ? (
              <>
                <label className={css.field}><span>{t('command')}<b className={css.requiredMark} aria-hidden="true">*</b></span><input required aria-label={t('command')} value={editor.draft.command} aria-invalid={editor.attempted && issues?.fields.command !== undefined} onChange={(event) => { update({ command: event.currentTarget.value }) }} /></label>
                <label className={css.field}><span>{t('args')}</span><input value={editor.draft.args} onChange={(event) => { update({ args: event.currentTarget.value }) }} /></label>
                <label className={css.field}><span>{t('cwd')}</span><input value={editor.draft.cwd} onChange={(event) => { update({ cwd: event.currentTarget.value }) }} /></label>
                <label className={css.field}><span>{t('env')}</span><textarea rows={7} value={editor.draft.env} aria-invalid={envIssue !== undefined} onChange={(event) => { update({ env: event.currentTarget.value }) }} />{envIssue !== undefined ? <em>{t(envIssue)}</em> : null}</label>
                <label className={css.field}><span>{t('envCredentialRefs')}</span><textarea rows={4} value={editor.draft.envCredentialRefs} aria-invalid={envCredentialRefsIssue !== undefined} onChange={(event) => { update({ envCredentialRefs: event.currentTarget.value }) }} />{envCredentialRefsIssue !== undefined ? <em>{t(envCredentialRefsIssue)}</em> : null}</label>
              </>
            ) : (
              <>
                <label className={css.field}><span>{t('url')}<b className={css.requiredMark} aria-hidden="true">*</b></span><input required aria-label={t('url')} value={editor.draft.url} aria-invalid={editor.attempted && issues?.fields.url !== undefined} onChange={(event) => { update({ url: event.currentTarget.value }) }} /></label>
                <label className={css.field}><span>{t('headers')}</span><textarea rows={7} value={editor.draft.headers} aria-invalid={headersIssue !== undefined} onChange={(event) => { update({ headers: event.currentTarget.value }) }} />{headersIssue !== undefined ? <em>{t(headersIssue)}</em> : null}</label>
                <label className={css.field}><span>{t('authorizationCredentialRef')}</span><input value={editor.draft.authorizationCredentialRef} aria-invalid={issues?.fields.authorizationCredentialRef !== undefined} onChange={(event) => { update({ authorizationCredentialRef: event.currentTarget.value }) }} />{issues?.fields.authorizationCredentialRef !== undefined ? <em>{t('invalidCredentialRef')}</em> : null}</label>
              </>
            )}
          </div>
        )}
        <div className={css.editorActions}>
          {editor.attempted && invalid ? <p className={css.validationSummary} role="alert">{t('fixValidation')}</p> : null}
          <Button variant="primary" size="sm" onClick={submit}>{t('save')}</Button>
          <Button variant="ghost" size="sm" onClick={() => { setEditor(null) }}>{t('cancel')}</Button>
        </div>
      </div>
    )
  }

  const normalizedQuery = query.trim().toLocaleLowerCase()
  const filtered = servers.filter(server => `${server.serverName} ${summary(server)}`.toLocaleLowerCase().includes(normalizedQuery))
  const openEditor = (index: number | null): void => {
    const draft = index === null ? blankDraft() : draftFromEntry(servers[index]!, `edit-${servers[index]!.serverName}`)
    setTransportMenuOpen(false)
    setEditor({ index, draft, mode: 'form', json: jsonFromDraft(draft), attempted: false })
  }

  return (
    <div className={css.pane}>
      <div className={css.toolbar}>
        <label className={css.search}>
          <IconSearchOutline16 aria-hidden="true" />
          <span className={css.visuallyHidden}>{t('searchServers')}</span>
          <input type="search" value={query} placeholder={t('searchServers')} onChange={(event) => { setQuery(event.currentTarget.value) }} />
        </label>
        <Tooltip label={t('refresh')} side="top">
          <button type="button" className={css.iconButton} aria-label={t('refresh')} disabled={statusLoading} onClick={refreshStatus}>
            <IconRefreshOutline16 size={15} />
          </button>
        </Tooltip>
        <Button variant="toolbar" size="sm" icon={<IconPlusOutline16 size={14} />} onClick={() => { openEditor(null) }}>{t('addServer')}</Button>
      </div>
      <div className={css.listHeading}>
        <h3>{t('configuredServers')}</h3><span>{t('serverCount', { count: String(servers.length) })}</span>
        {statusFailed ? <span role="alert">{t('statusLoadFailed')}</span> : null}
      </div>
      {servers.length === 0 ? <p className={css.status}>{t('emptyServers')}</p> : null}
      {servers.length > 0 && filtered.length === 0 ? <p className={css.status}>{t('emptySearch')}</p> : null}
      {filtered.length > 0 ? (
        <ul className={css.serverList}>
          {filtered.map((server) => {
            const index = servers.indexOf(server)
            const live = inventory?.servers.find(item => item.serverName === server.serverName)
            const connection = server.enabled
              ? statusFailed ? 'failed' : live?.connection ?? 'connecting'
              : 'disabled'
            const connectionPending = connection === 'connecting' || connection === 'reconnecting'
            const connectionText = statusFailed && server.enabled
              ? t('connectionFailed')
              : connectionLabel(server, live, t)
            return (
              <li className={css.serverRow} key={server.serverName} data-enabled={server.enabled} data-connection={connection}>
                <div className={css.serverMain}>
                  <div className={css.serverTitle}>
                    {connectionPending
                      ? <span className={css.connectionSpinner} role="status" aria-label={connectionText}><IconLoadingOutline16 size={13} /></span>
                      : <span className={css.connectionDot} role="status" aria-label={connectionText} />}
                    <strong>{server.serverName}</strong>
                    <span className={css.transportTag}>{server.transport === 'stdio' ? t('transportStdio') : t('transportHttp')}</span>
                    {!connectionPending && connection !== 'connected' ? <span className={css.connectionLabel}>{connectionText}</span> : null}
                    {server.enabled && live?.connection === 'connected' ? <span className={css.toolTag}>{t('toolCount', { count: String(live.toolCount) })}</span> : null}
                  </div>
                  <code>{summary(server)}</code>
                </div>
                <div className={css.rowActions}>
                  <label className={css.switch}>
                    <input type="checkbox" checked={server.enabled} aria-label={t('toggleServer', { name: server.serverName })} onChange={() => { persist(servers.map((item, itemIndex) => itemIndex === index ? { ...item, enabled: !item.enabled } : item), !server.enabled) }} />
                    <span />
                  </label>
                  <Tooltip label={t('editServer')} side="top"><button type="button" className={css.iconButton} aria-label={t('editServer')} onClick={() => { openEditor(index) }}><IconEditOutline16 size={15} /></button></Tooltip>
                  <Tooltip label={t('removeServer')} side="top"><button type="button" className={`${css.iconButton} ${css.iconButtonDanger}`} aria-label={t('removeServer')} onClick={() => { persist(servers.filter((_item, itemIndex) => itemIndex !== index)) }}><IconTrashOutline16 size={15} /></button></Tooltip>
                </div>
              </li>
            )
          })}
        </ul>
      ) : null}
      <div className={css.saveStatus} aria-live="polite">
        {saveNotice === 'saving' ? <span>{t('saving')}</span> : null}
        {saveNotice === 'saved' ? <span>{t('saved')}</span> : null}
        {saveNotice === 'failed' ? <span role="alert">{t('saveFailed', { message: '' }).replace(': ', '')}</span> : null}
      </div>
    </div>
  )
}
