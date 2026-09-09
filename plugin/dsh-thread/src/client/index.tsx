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
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import React from 'react'
import { isThreadHandoffDraft, type ThreadHandoffDraft } from '../draft.ts'
import { deriveRecoveryView, type RecoveryAction } from '../recovery.ts'
import type { AuthorizeRequest, StateResult, ThreadDraftRecord, ThreadLink, TitleOutcome } from '../thread-types.ts'
import TYPERT_REMOTE from '../typert.remote-client.ts'
import { THREAD_SETTINGS_NAMESPACE, type ThreadSettings } from '../thread-types.ts'
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
  /** Drive the whole saga from the current durable checkpoint to `relation: active`. */
  drive(request: AuthorizeRequest): Promise<ThreadLink>
  /** User-confirmed redelivery of an uncertain delivery. */
  redeliver(linkId: string): Promise<ThreadLink>
  /** Clone a stuck link into a fresh Draft and build its continuation request. */
  clone(linkId: string): Promise<ContinuationRequest>
  /** Cancel a not-yet-delivered authorization. */
  abandon(linkId: string): Promise<void>
  /** The Thread master switch mirrored from the Host settings namespace. */
  enabled: ThreadEnabledStore
  togglePanel(): void
  /** Open the Thread panel — used when the card navigates to the target Session. */
  openPanel(): void
}

function remoteError(result: { ok: false; error: { code: string; message: string } }): Error {
  return new Error(`${result.error.code}: ${result.error.message}`)
}

/**
 * Staleness the client resolves itself by re-reading the durable link: these
 * codes mean "your view is old", never a user-facing failure.
 */
function isStaleError(message: string): boolean {
  return message.includes('cas-failed')
    || message.includes('creation-in-flight')
    || message.includes('link-not-found')
    || message.includes('target-not-published')
}

function createActionId(): string {
  return `thread-action-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

/** Host activation codes translated for the card; unknown codes pass through. */
const FRIENDLY_ACTIVATE_ERRORS: Record<string, string> = {
  'delivery-uncertain': '上一次投递结果未知，确认后可重新投递',
  'target-not-idle': '目标会话正在运行，请稍后再试',
  'target-not-live': '目标会话未就绪，请重新检查',
  'target-diverged': '目标会话已产生本交接之外的输入，不会再注入 Handoff',
  'link-abandoned': '该交接授权已取消',
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
  notice: { color: 'var(--dsw-alias-label-secondary)' },
  warning: { color: 'var(--dsw-alias-state-warn-primary)' },
  headerButton: { width: 28, minWidth: 28, padding: 0 },
} as const

const ACTION_LABELS: Record<RecoveryAction, string> = {
  'continue-creation': '继续创建',
  recheck: '重新检查',
  'start-handoff': '启动交接',
  'open-target': '打开已创建会话',
  clone: '克隆到新会话',
  redeliver: '重新投递',
  'open-thread': '打开 Thread 会话',
  cancel: '取消授权',
}

function requestFromDraft(draft: ThreadDraftRecord): ContinuationRequest {
  return {
    sourceSessionId: draft.sourceSessionId,
    draftId: draft.draftId,
    draftVersion: draft.version,
    ...(draft.targetTitle === null || draft.targetTitle === undefined ? {} : { title: draft.targetTitle }),
    handoff: {
      objective: draft.handoff.objective,
      confirmedConclusions: [...draft.handoff.confirmedConclusions],
      constraints: [...draft.handoff.constraints],
      openQuestions: [...draft.handoff.openQuestions],
      artifacts: [...draft.handoff.artifacts],
    },
    instruction: draft.instruction,
  }
}

function ContinueButton(props: {
  face: ThreadFace
  request: ContinuationRequest
  useSessions: UseSessions
}): React.ReactElement {
  const [request, setRequest] = React.useState<ContinuationRequest>(props.request)
  const [link, setLink] = React.useState<ThreadLink | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [notice, setNotice] = React.useState<string | null>(null)
  const [armedRedeliver, setArmedRedeliver] = React.useState(false)
  const [openedTarget, setOpenedTarget] = React.useState<string | null>(null)
  const target = link === null ? null : link.targetSessionId as SessionId
  const visible = props.useSessions((state) => target !== null && state.byId[target] !== undefined)

  // Rehydrate from the durable link: the card always renders the persisted
  // checkpoint's real recovery actions, never a generic retry that the Host
  // would reject anyway.
  const refresh = React.useCallback(async (): Promise<ThreadLink | null> => {
    const state = await props.face.loadState()
    const found = state.links.find(item => item.draftId === request.draftId) ?? null
    setLink(found)
    return found
  }, [props.face, request.draftId])

  React.useEffect(() => {
    let live = true
    void refresh().then(found => {
      if (live && found !== null && found.relation === 'active') setOpenedTarget(found.targetSessionId)
    }).catch(() => {})
    return () => { live = false }
  }, [refresh])

  React.useEffect(() => {
    if (link === null || link.relation !== 'active' || target === null || !visible) return
    if (openedTarget === link.targetSessionId) return
    setOpenedTarget(link.targetSessionId)
    props.face.openSession(target)
    // First arrival at the new Session: the Thread panel opens with it so the
    // carried context is immediately visible.
    props.face.openPanel()
  }, [link, target, visible, openedTarget, props.face])

  const runDrive = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    setNotice(null)
    setArmedRedeliver(false)
    try {
      const active = await props.face.drive({ ...request, actionId: createActionId() })
      setLink(active)
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason)
      await refresh().catch(() => {})
      if (isStaleError(message)) setNotice('状态已更新，请按最新状态操作')
      else setError(message)
    } finally {
      setBusy(false)
    }
  }

  const openTarget = (): void => {
    if (target === null) return
    props.face.openSession(target)
    props.face.openPanel()
  }

  const runAction = async (action: RecoveryAction): Promise<void> => {
    if (link === null) return
    if (action === 'open-target' || action === 'open-thread') {
      openTarget()
      return
    }
    if (action === 'redeliver') {
      if (!armedRedeliver) {
        setArmedRedeliver(true)
        return
      }
      setBusy(true)
      setError(null)
      setNotice(null)
      setArmedRedeliver(false)
      try {
        const active = await props.face.redeliver(link.linkId)
        setLink(active)
      } catch (reason) {
        const message = reason instanceof Error ? reason.message : String(reason)
        await refresh().catch(() => {})
        if (isStaleError(message)) setNotice('状态已更新，请按最新状态操作')
        else setError(message)
      } finally {
        setBusy(false)
      }
      return
    }
    if (action === 'clone') {
      setBusy(true)
      setError(null)
      setNotice(null)
      setArmedRedeliver(false)
      try {
        const cloned = await props.face.clone(link.linkId)
        setRequest(cloned)
        const active = await props.face.drive({ ...cloned, actionId: createActionId() })
        setLink(active)
      } catch (reason) {
        const message = reason instanceof Error ? reason.message : String(reason)
        await refresh().catch(() => {})
        if (isStaleError(message)) setNotice('状态已更新，请按最新状态操作')
        else setError(message)
      } finally {
        setBusy(false)
      }
      return
    }
    if (action === 'cancel') {
      setBusy(true)
      try {
        await props.face.abandon(link.linkId)
        await refresh().catch(() => {})
        setNotice('已取消该交接授权')
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason))
        await refresh().catch(() => {})
      } finally {
        setBusy(false)
      }
      return
    }
    await runDrive()
  }

  const view = link === null ? null : deriveRecoveryView(link)
  const primary: RecoveryAction | null = link === null ? 'continue-creation' : view?.primary ?? null
  const secondary = link === null ? [] : view?.secondary ?? []
  const completed = link !== null && link.relation === 'active'
  const primaryLabel = primary === 'redeliver' && armedRedeliver ? '确认重新投递' : primary === null ? null : ACTION_LABELS[primary]

  return (
    <div style={styles.action}>
      {primary !== null && primaryLabel !== null && (
        <Button
          variant="primary"
          size="sm"
          icon={<IconBranchOutline16 />}
          style={styles.actionButton}
          disabled={busy}
          onClick={() => void runAction(primary)}
        >
          {busy ? '处理中...' : primaryLabel}
        </Button>
      )}
      {secondary.map(action => (
        <Button
          key={action}
          variant="ghost"
          size="sm"
          style={styles.actionButton}
          disabled={busy}
          onClick={() => void runAction(action)}
        >
          {ACTION_LABELS[action]}
        </Button>
      ))}
      {(completed || error !== null || notice !== null || view?.summary !== null || view?.titleWarning !== null) && (
        <div style={styles.feedback} aria-live="polite">
          {completed && <span style={styles.success}>已携带上下文创建新会话</span>}
          {notice !== null && <span style={styles.notice}>{notice}</span>}
          {error !== null && <span style={styles.error}>{error}</span>}
          {view?.summary !== null && view !== null && view.summary !== null && (
            <span style={styles.notice}>{view.summary}</span>
          )}
          {view?.titleWarning !== null && view !== null && view.titleWarning !== null && (
            <span style={styles.warning}>{view.titleWarning}</span>
          )}
          {armedRedeliver && view !== null && view.deliveryWarning !== null && (
            <span style={styles.warning}>{view.deliveryWarning}</span>
          )}
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

  async function readLink(linkId: string): Promise<ThreadLink> {
    const state = await loadState()
    const link = state.links.find(item => item.linkId === linkId)
    if (link === undefined) throw new Error('thread: link vanished')
    return link
  }

  async function loadState(): Promise<StateResult> {
    const result = await gateway.state()
    if (!result.ok) throw remoteError(result)
    return result.value
  }

  /** Issue the deterministic idempotent create, recording a structured failure when it errors. */
  async function ensureCreated(link: ThreadLink): Promise<void> {
    let failure: string | null = null
    try {
      const created = await sessionRemote.create({
        sessionId: link.targetSessionId as SessionId,
        agentPreset: link.agentPreset,
        ...(link.targetWorkspaceId === null ? {} : { workspaceId: link.targetWorkspaceId as WorkspaceId }),
        ...(link.targetCwd === null ? {} : { cwd: link.targetCwd }),
      })
      if (!created.ok) failure = `${created.error.code}: ${created.error.message}`
    } catch (reason) {
      // No coded remote result: the outcome itself is unknown. The Host
      // classifies by code prefix, so this lands as a resume-able create
      // failure; the idempotent create settles it on the next try.
      failure = (reason instanceof Error ? reason.message : String(reason)).slice(0, 500)
    }
    if (failure !== null) {
      await gateway.reconcileTarget({ linkId: link.linkId, createError: failure }).catch(() => {})
      throw new Error(failure)
    }
  }

  /** One rename attempt with authoritative-outcome recording. Never blocks activation. */
  async function deliverTitle(link: ThreadLink): Promise<void> {
    if (link.title.phase !== 'pending' || link.title.requested === null) return
    const attempt = link.creationActionId
    if (attempt === null) return
    let outcome: TitleOutcome
    try {
      const rename = await sessionRemote.rename({
        sessionId: link.targetSessionId as SessionId,
        title: link.title.requested,
      })
      // The accepted title and eventSeq come from the response — the upstream
      // Session Title service owns normalization (whitespace, control
      // characters, byte caps); Thread never copies those rules.
      outcome = rename.ok
        ? { kind: 'accepted', title: rename.value.title, eventSeq: rename.value.seq }
        : { kind: 'failed', error: `${rename.error.code}: ${rename.error.message}`.slice(0, 500) }
    } catch (reason) {
      // Thrown without a coded result: response unknown. Do NOT auto-retry —
      // a repeated rename could append a second title event. Reconciliation
      // adopts the target's current title instead.
      outcome = {
        kind: 'unknown',
        error: (reason instanceof Error ? reason.message : String(reason)).slice(0, 500),
      }
    }
    // Recording is advisory by design: activation never waits on the title,
    // and when the outcome cannot be durably recorded, reconciliation adopts
    // the authoritative title from the target log instead.
    try {
      await gateway.recordTitle({ linkId: link.linkId, attempt, outcome })
    } catch {
      // transport or cas rejection — the drive loop re-reads the durable link
    }
  }

  async function drive(request: AuthorizeRequest): Promise<ThreadLink> {
    const authorized = await gateway.authorize(request)
    if (!authorized.ok) throw remoteError(authorized)
    if (!authorized.value.ok) throw new Error(authorized.value.error)
    const plan = authorized.value

    for (let pass = 0; pass < 6; pass++) {
      const link = await readLink(plan.linkId)
      if (link.relation === 'active') return link
      const view = deriveRecoveryView(link)
      const action = view.primary

      if (action === 'open-thread' || action === null) return link

      if (action === 'continue-creation' || action === 'recheck') {
        // Creation checkpoint; `creation-in-flight` from another window is
        // stale information — the reconcile probe decides what really exists.
        try {
          const begun = await gateway.beginCreation({ linkId: plan.linkId, actionId: createActionId() })
          if (!begun.ok) throw remoteError(begun)
          if (!begun.value.ok && !isStaleError(begun.value.error)) throw new Error(begun.value.error)
        } catch (reason) {
          const message = reason instanceof Error ? reason.message : String(reason)
          if (!isStaleError(message)) throw reason
        }
        const probed = await gateway.reconcileTarget({ linkId: plan.linkId })
        if (!probed.ok) throw remoteError(probed)
        if (!probed.value.ok) {
          if (isStaleError(probed.value.error)) continue
          throw new Error(probed.value.error)
        }
        if (probed.value.next === 'create') {
          await ensureCreated(probed.value.link)
          const settled = await gateway.reconcileTarget({ linkId: plan.linkId })
          if (!settled.ok) throw remoteError(settled)
          if (!settled.value.ok) {
            if (isStaleError(settled.value.error)) continue
            throw new Error(settled.value.error)
          }
        }
        continue
      }

      if (action === 'start-handoff') {
        await deliverTitle(link)
        const activated = await gateway.activate({ linkId: plan.linkId })
        if (!activated.ok) throw remoteError(activated)
        if (!activated.value.ok) {
          if (isStaleError(activated.value.error)) continue
          const refreshed = await readLink(plan.linkId).catch(() => null)
          if (refreshed !== null && refreshed.relation === 'active') return refreshed
          // Transient states and the uncertain delivery surface through the
          // refreshed checkpoint's real actions, with human wording.
          throw new Error(FRIENDLY_ACTIVATE_ERRORS[activated.value.error] ?? activated.value.error)
        }
        continue
      }

      // redeliver / open-target / clone need an explicit user click.
      throw new Error(view.summary ?? 'thread: 该状态需要用户选择具体操作')
    }
    throw new Error('thread: 交接流程未能收敛，请刷新状态后重试')
  }

  const face: ThreadFace = {
    enabled: threadEnabled,
    drive,
    async redeliver(linkId) {
      const activated = await gateway.activate({ linkId, redeliver: true })
      if (!activated.ok) throw remoteError(activated)
      if (!activated.value.ok) throw new Error(activated.value.error)
      return activated.value.link
    },
    async clone(linkId) {
      const cloned = await gateway.cloneDraft({ linkId })
      if (!cloned.ok) throw remoteError(cloned)
      if (!cloned.value.ok) throw new Error(cloned.value.error)
      return requestFromDraft(cloned.value.draft)
    },
    async abandon(linkId) {
      const abandoned = await gateway.abandon({ linkId })
      if (!abandoned.ok) throw remoteError(abandoned)
      if (!abandoned.value.ok) throw new Error(abandoned.value.error)
    },
    isPanelOpen: panelVisibility.getSnapshot,
    async loadState(): Promise<StateResult> {
      return await loadState()
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
    // General settings row's switch vocabulary. Pre-claimed with
    // `data-plugin`/`data-plugin-css` (the stock build-time CSS emission
    // convention) and dedup-guarded: the client module system's claimStyles
    // attributes every UNTAGGED <style> to whichever plugin materializes
    // next, and that plugin's next HMR reload deletes the claimed sheet
    // (the 2026-09-08 bridge incident). A claimed tag is only touched by a
    // rebuild of THIS plugin, whose reload re-inserts the sheet anyway.
    ctx.effect(() => {
      const tagId = 'dsh-thread/client-css'
      if (document.querySelector(`style[data-plugin-css="${tagId}"]`) !== null) return () => {}
      const style = document.createElement('style')
      style.dataset.dshThread = 'client-css'
      style.dataset.plugin = 'dsh-thread'
      style.dataset.pluginCss = tagId
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
