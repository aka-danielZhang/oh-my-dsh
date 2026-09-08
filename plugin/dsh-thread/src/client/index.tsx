import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/remote'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import { Button, IconBranchOutline16, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session'
import React from 'react'
import { isThreadHandoffDraft, type ThreadHandoffDraft } from '../draft.ts'
import TYPERT_REMOTE from '../typert.remote-client.ts'
import { THREAD_SETTINGS_NAMESPACE, type ThreadSettings } from '../thread-types.ts'
import type { AuthorizeRequest, StateResult, ThreadLink } from '../thread-types.ts'
import { bindThreadEnabled, type ThreadEnabledStore } from './enabled.ts'
import { en, zh, type ThreadLocaleKey } from './locales.ts'
import { ThreadPanel, type ThreadPanelFace } from './panel.tsx'
import { createThreadPanelVisibility } from './panel-visibility.ts'
import { THREAD_SETTINGS_ROW_CSS, ThreadSettingsRow } from './settings-row.tsx'
import { THREAD_SIDEBAR_CSS, ThreadSidebarView } from './sidebar-view.tsx'

export const inject = ['slots', 'locale', 'sessions', 'remote', 'remote.session', 'settingsScope']

/** Dictionary namespace owned by this plugin. */
const LOCALE_NS = 'dsh-thread'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Thread settings-row copy. */
    'dsh-thread': ThreadLocaleKey
  }
}

type UseSessions = ToolCallViewProps['useSessions']
type ContinuationRequest = Omit<AuthorizeRequest, 'actionId'>
type HeaderUtilityProps = PropsRuntime<'conversation.session.header.utilities'> & { threadFace: ThreadFace }
type ThreadOverlayProps = PropsRuntime<'shell.overlay'> & { threadFace: ThreadFace }

interface ThreadFace extends ThreadPanelFace {
  continue(request: AuthorizeRequest): Promise<ThreadLink>
  /** The Thread master switch mirrored from the Host settings namespace. */
  enabled: ThreadEnabledStore
  togglePanel(): void
  /** Open the Thread panel — used when the card navigates to the target Session. */
  openPanel(): void
}

function remoteError(result: { ok: false; error: { code: string; message: string } }): Error {
  return new Error(`${result.error.code}: ${result.error.message}`)
}

function createActionId(): string {
  return `thread-action-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

const styles = {
  root: {
    display: 'flex', flexDirection: 'column', gap: 10, padding: '8px 0 4px',
    color: 'var(--dsw-alias-label-primary)', fontSize: 12, lineHeight: 1.5,
  },
  cardRoot: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap',
    gap: 12, padding: '10px 0 6px', color: 'var(--dsw-alias-label-primary)', lineHeight: 1.5,
  },
  summary: { display: 'flex', flex: '1 1 360px', minWidth: 0, flexDirection: 'column', gap: 3 },
  threadLabel: {
    display: 'inline-flex', alignItems: 'center', gap: 6,
    color: 'var(--dsw-alias-label-secondary)', fontSize: 11, fontWeight: 600,
  },
  objective: { overflowWrap: 'anywhere', fontSize: 13, fontWeight: 600, lineHeight: 1.55 },
  secondary: { color: 'var(--dsw-alias-label-secondary)', fontSize: 11 },
  action: { display: 'flex', flex: '0 1 auto', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
  actionButton: { minWidth: 124 },
  feedback: { flexBasis: '100%' },
  error: { color: 'var(--dsw-alias-state-error-primary)', whiteSpace: 'pre-wrap' },
  success: { color: 'var(--dsw-alias-state-success-primary)' },
  headerButton: { width: 28, minWidth: 28, padding: 0 },
} as const

function ContinueButton(props: {
  face: ThreadFace
  request: ContinuationRequest
  useSessions: UseSessions
}): React.ReactElement {
  const [phase, setPhase] = React.useState<'idle' | 'running' | 'syncing' | 'complete' | 'failed'>('idle')
  const [error, setError] = React.useState<string | null>(null)
  const [target, setTarget] = React.useState<SessionId | null>(null)
  const visible = props.useSessions((state) => target !== null && state.byId[target] !== undefined)

  // Rehydrate from the durable link: a draft already consumed by an earlier
  // confirmation (possibly before a reload) renders its outcome, never a
  // second CTA that would spawn a duplicate Session with a fresh actionId.
  React.useEffect(() => {
    let live = true
    void props.face.loadState().then((state) => {
      if (!live) return
      const link = state.links.find(l => l.draftId === props.request.draftId)
      if (link === undefined) return
      if (link.state === 'active') {
        setTarget(link.targetSessionId as SessionId)
        setPhase('complete')
      } else if (link.state === 'failed' || link.state === 'uncertain') {
        setError(link.failure ?? 'unknown failure')
        setPhase('failed')
      } else {
        // authorized/creating/activating: creation is in flight elsewhere.
        setPhase('running')
      }
    }).catch(() => {})
    return () => { live = false }
  }, [props.face, props.request.draftId])

  React.useEffect(() => {
    if (phase !== 'syncing' || target === null || !visible) return
    props.face.openSession(target)
    // First button-driven arrival at the new Session: the Thread panel opens
    // with it so the carried context is immediately visible.
    props.face.openPanel()
    setPhase('complete')
  }, [phase, target, visible, props.face])

  const run = async () => {
    setPhase('running')
    setError(null)
    try {
      const link = await props.face.continue({
        ...props.request,
        actionId: createActionId(),
      })
      setTarget(link.targetSessionId as SessionId)
      setPhase('syncing')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
      setPhase('failed')
    }
  }

  const open = (): void => {
    if (target === null) return
    props.face.openSession(target)
    props.face.openPanel()
  }

  const busy = phase === 'running' || phase === 'syncing'
  return (
    <div style={styles.action}>
      {phase === 'complete' && target !== null ? (
        <Button
          variant="primary"
          size="sm"
          icon={<IconBranchOutline16 />}
          style={styles.actionButton}
          onClick={open}
        >
          打开 Thread 会话
        </Button>
      ) : (
        <Button
          variant="primary"
          size="sm"
          icon={<IconBranchOutline16 />}
          style={styles.actionButton}
          disabled={busy}
          onClick={() => void run()}
        >
          {busy ? '正在创建...' : phase === 'failed' ? '重试' : '在 Thread 中继续'}
        </Button>
      )}
      {(phase === 'complete' || error !== null) && (
        <div style={styles.feedback} aria-live="polite">
          {phase === 'complete' && <span style={styles.success}>已携带上下文创建新会话</span>}
          {error !== null && <span style={styles.error}>{error}</span>}
        </div>
      )}
    </div>
  )
}

function cardRequest(draft: ThreadHandoffDraft): ContinuationRequest {
  return {
    sourceSessionId: draft.sourceSessionId,
    draftId: draft.draftId,
    draftVersion: draft.version ?? 1,
    ...(draft.targetTitle === undefined ? {} : { title: draft.targetTitle }),
    handoff: {
      objective: draft.objective,
      confirmedConclusions: draft.confirmedConclusions,
      constraints: draft.constraints,
      openQuestions: draft.openQuestions,
      artifacts: draft.artifacts ?? [],
    },
    instruction: draft.nextInstruction,
  }
}

function ThreadHandoffCard(props: ToolCallViewProps & { threadFace: ThreadFace }): React.ReactElement {
  const { block } = props
  const enabled = React.useSyncExternalStore(
    props.threadFace.enabled.subscribe,
    props.threadFace.enabled.getSnapshot,
    props.threadFace.enabled.getSnapshot,
  )
  if (!('kind' in block) || block.kind !== 'tool-result') {
    return <div style={styles.root}>正在整理脉络交接...</div>
  }
  if (block.isError) return <div style={styles.root}>交接草稿生成失败</div>
  if (!isThreadHandoffDraft(block.meta)) return <div style={styles.root}>交接草稿缺少 durable meta</div>
  const draft = block.meta
  const contextCount = draft.confirmedConclusions.length + draft.constraints.length + draft.openQuestions.length + (draft.artifacts?.length ?? 0)
  return (
    <div style={styles.cardRoot}>
      <div style={styles.summary}>
        <span style={styles.threadLabel}><IconBranchOutline16 />Thread 交接</span>
        <span style={styles.objective}>{draft.objective}</span>
        <span style={styles.secondary}>
          {enabled
            ? `携带 ${contextCount} 条上下文，在同一工作区的新会话中继续`
            : 'Thread 已在「设置 → 通用」中停用，交接草稿仅作记录'}
        </span>
      </div>
      {enabled && (
        <ContinueButton
          face={props.threadFace}
          request={cardRequest(draft)}
          useSessions={props.useSessions}
        />
      )}
    </div>
  )
}

function HeaderUtility(props: HeaderUtilityProps): React.ReactElement | null {
  // A blank (empty-log, not-yet-started) Session has no Thread entry point:
  // the utility stays hidden, so the panel can never open over a fresh chat.
  const blank = props.useSessions((state) => {
    const summary = state.byId[props.sessionId]
    return summary === undefined || summary.blank
  })
  // The master switch hides the entry without touching the panel store.
  const enabled = React.useSyncExternalStore(
    props.threadFace.enabled.subscribe,
    props.threadFace.enabled.getSnapshot,
    props.threadFace.enabled.getSnapshot,
  )
  const panelOpen = React.useSyncExternalStore(
    props.threadFace.subscribePanel,
    props.threadFace.isPanelOpen,
    props.threadFace.isPanelOpen,
  )
  if (blank || !enabled) return null
  const label = panelOpen ? '隐藏 Thread' : '查看 Thread'
  return (
    <Tooltip label={label} side="bottom" delayMs={400}>
      <Button
        variant="ghost"
        size="sm"
        icon={<IconBranchOutline16 />}
        style={{
          ...styles.headerButton,
          ...(panelOpen ? { background: 'var(--dsw-alias-bg-layer-2)' } : {}),
        }}
        aria-label={label}
        aria-expanded={panelOpen}
        aria-controls="dsh-thread-capsule"
        onClick={() => props.threadFace.togglePanel()}
      />
    </Tooltip>
  )
}

interface CapsulePlacement extends React.CSSProperties {
  maxHeight: number
  right: number
  top: number
  width: number
}

function ThreadCapsuleOverlay(props: ThreadOverlayProps): React.ReactElement | null {
  const panelOpen = React.useSyncExternalStore(
    props.threadFace.subscribePanel,
    props.threadFace.isPanelOpen,
    props.threadFace.isPanelOpen,
  )
  const sessionId = props.useSessions((state) => state.current)
  // Blank (not-yet-started) Sessions never show the capsule: the store may
  // stay open across navigation, but rendering and placement both gate on a
  // started Session so a fresh chat never gets the empty Thread surface.
  const currentBlank = props.useSessions((state) =>
    state.current === undefined ? true : (state.byId[state.current]?.blank ?? true))
  // The master switch hides the capsule without disturbing the open state.
  const enabled = React.useSyncExternalStore(
    props.threadFace.enabled.subscribe,
    props.threadFace.enabled.getSnapshot,
    props.threadFace.enabled.getSnapshot,
  )
  const [placement, setPlacement] = React.useState<CapsulePlacement | null>(null)

  React.useLayoutEffect(() => {
    setPlacement(null)
    if (!panelOpen || sessionId === undefined || currentBlank || !enabled) return
    const conversationBody = document.querySelector<HTMLElement>('[data-conversation-scroll]')
    if (conversationBody === null) return

    const updatePlacement = (): void => {
      const rect = conversationBody.getBoundingClientRect()
      const inset = 16
      setPlacement({
        top: rect.top + inset,
        right: Math.max(inset, window.innerWidth - rect.right + inset),
        width: Math.max(0, Math.min(460, rect.width - inset * 2)),
        maxHeight: Math.max(0, rect.height - inset * 2),
      })
    }

    updatePlacement()
    const observer = new ResizeObserver(updatePlacement)
    observer.observe(conversationBody)
    window.addEventListener('resize', updatePlacement)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', updatePlacement)
    }
  }, [panelOpen, sessionId, currentBlank, enabled])

  if (!panelOpen || sessionId === undefined || currentBlank || !enabled || placement === null) return null
  return (
    <ThreadPanel
      sessionId={sessionId}
      useSessions={props.useSessions}
      placement={placement}
      threadFace={props.threadFace}
    />
  )
}

export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const disposeRemote = ctx.get('remote.thread') === undefined
    ? await ctx.remote.$mount(TYPERT_REMOTE)
    : async (): Promise<void> => {}
  const gateway = ctx.get('remote.thread')
  // Harness 0.1.2 removed `connection.api`; Session create/rename now live on
  // the typed `session` Remote namespace (the outward `ctx.sessions.create`
  // face still cannot carry agentPreset, which the Thread contract requires).
  const sessionRemote = ctx.remote.session
  const clientSessions = ctx.get('sessions') as ISessions | undefined
  if (gateway === undefined || sessionRemote === undefined || clientSessions === undefined) {
    await disposeRemote()
    throw new Error('dsh-thread: Thread Remote, session Remote, or Client sessions did not mount')
  }

  const panelVisibility = createThreadPanelVisibility()
  // The master switch mirrors the Host `dsh-thread` settings namespace; the
  // settings row is its home, the rest of the surface subscribes read-only.
  const settingsScope = ctx.settingsScope.bind<ThreadSettings>({ namespace: THREAD_SETTINGS_NAMESPACE })
  const threadEnabled = bindThreadEnabled(settingsScope)

  const face: ThreadFace = {
    enabled: threadEnabled,
    async continue(request) {
      const authorized = await gateway.authorize(request)
      if (!authorized.ok) throw remoteError(authorized)
      if (!authorized.value.ok) throw new Error(authorized.value.error)
      const plan = authorized.value

      const begun = await gateway.beginCreation({ linkId: plan.linkId, actionId: request.actionId })
      if (!begun.ok) throw remoteError(begun)
      if (!begun.value.ok) throw new Error(begun.value.error)
      if (begun.value.link.state === 'active') return begun.value.link

      const created = await sessionRemote.create({
        sessionId: plan.createPlan.sessionId as SessionId,
        agentPreset: plan.createPlan.agentPreset,
        ...(plan.createPlan.workspaceId === undefined
          ? {}
          : { workspaceId: plan.createPlan.workspaceId }),
        ...(plan.createPlan.cwd === undefined ? {} : { cwd: plan.createPlan.cwd }),
      })
      if (!created.ok) throw new Error(`${created.error.code}: ${created.error.message}`)

      if (plan.titlePlan !== undefined) {
        let renamed = false
        try {
          const rename = await sessionRemote.rename({
            sessionId: plan.titlePlan.sessionId as SessionId,
            title: plan.titlePlan.title,
          })
          renamed = rename.ok
        } finally {
          const recorded = await gateway.recordTitle({ linkId: plan.linkId, ok: renamed })
          if (!recorded.ok) throw remoteError(recorded)
          if (!recorded.value.ok) throw new Error(recorded.value.error)
        }
      }

      const activated = await gateway.activate({ linkId: plan.linkId })
      if (!activated.ok) throw remoteError(activated)
      if (!activated.value.ok) throw new Error(activated.value.error)
      return activated.value.link
    },
    isPanelOpen: panelVisibility.getSnapshot,
    async loadState(): Promise<StateResult> {
      const result = await gateway.state()
      if (!result.ok) throw remoteError(result)
      return result.value
    },
    openSession(sessionId) {
      clientSessions.open(sessionId)
    },
    subscribePanel: panelVisibility.subscribe,
    togglePanel: panelVisibility.toggle,
    openPanel: panelVisibility.open,
  }

  try {
    ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), 'dsh-thread: dictionaries')

    // The settings row is the switch's home: always registered, never gated.
    ctx.slots.inject('settings.general.item', () => ctx.slots.register({
      name: 'settings.general.item',
      id: 'thread',
      order: 20,
      label: 'Thread',
      locale: LOCALE_NS,
      inject: () => ({
        threadEnabled,
        setThreadEnabled: (enabled: boolean) => {
          void settingsScope.set('enabled', enabled).catch(() => {})
        },
      }),
    }, ThreadSettingsRow))

    // The Thread-grouped sidebar view. The slot declaration ships with the
    // fork's ui-workspace; where it is absent this injection simply never
    // fires. Registration follows the switch so a disabled Thread never
    // occupies the view-mode menu.
    ctx.slots.inject('sidebar.workspaces.sessionListView', () => {
      let dispose: (() => void) | undefined
      const sync = (): void => {
        if (threadEnabled.getSnapshot() && dispose === undefined) {
          dispose = ctx.slots.register({
            name: 'sidebar.workspaces.sessionListView',
            id: 'thread',
            order: 10,
            label: 'Thread 分组',
            inject: () => ({ threadFace: face }),
          }, ThreadSidebarView)
        } else if (!threadEnabled.getSnapshot() && dispose !== undefined) {
          dispose()
          dispose = undefined
        }
      }
      sync()
      return threadEnabled.subscribe(sync)
    })

    // Hover affordance for the sidebar view's token-styled rows, plus the
    // General settings row's switch vocabulary.
    ctx.effect(() => {
      const style = document.createElement('style')
      style.dataset.dshThread = 'client-css'
      style.textContent = THREAD_SIDEBAR_CSS + '\n' + THREAD_SETTINGS_ROW_CSS
      document.head.appendChild(style)
      return () => { style.remove() }
    })

    ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
      name: 'conversation.session.header.utilities',
      id: 'dsh-thread-panel',
      order: 40,
      label: '查看 Thread',
      inject: () => ({ threadFace: face }),
    }, HeaderUtility))
    ctx.slots.inject('shell.overlay', () => ctx.slots.register({
      name: 'shell.overlay',
      id: 'dsh-thread-capsule',
      order: 20,
      label: 'Thread 面板',
      inject: () => ({ threadFace: face }),
    }, ThreadCapsuleOverlay))
    ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
      name: 'tool.call.toolview',
      key: 'thread_handoff',
      inject: () => ({ threadFace: face }),
    }, ThreadHandoffCard))
    return async () => {
      panelVisibility.close()
      await disposeRemote()
    }
  } catch (error) {
    await disposeRemote()
    throw error
  }
}
