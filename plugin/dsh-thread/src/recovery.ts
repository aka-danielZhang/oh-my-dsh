import type { ThreadLink } from './thread-types.ts'

/**
 * Recovery view derived from the orthogonal checkpoints. Every action is a
 * real, executable step — the generic "retry" is deliberately absent: each
 * button names exactly what the saga will do next, and `cas-failed` style
 * staleness is handled by re-reading state, never shown to the user.
 */
export type RecoveryAction =
  | 'continue-creation'  // reserved: begin + create the deterministic target
  | 'recheck'            // creating / create-failure: reconcile by deterministic id
  | 'start-handoff'      // published + pristine: title (optional) + activate
  | 'open-target'        // target exists and is viewable
  | 'clone'              // seal a fresh Draft/Link/target from this one
  | 'redeliver'          // uncertain delivery: user-confirmed new message ids
  | 'open-thread'        // relation active: nothing left to drive
  | 'cancel'             // reserved: abandon the authorization

export interface RecoveryView {
  /** The action the primary button drives; null when nothing is drivable. */
  primary: RecoveryAction | null
  /** Secondary actions rendered beside the primary one. */
  secondary: RecoveryAction[]
  /** Non-blocking title warning (failed/unknown title never gates activation). */
  titleWarning: string | null
  /** Risk note that must be confirmed before a redelivery. */
  deliveryWarning: string | null
  /** Human-readable checkpoint summary for the feedback line. */
  summary: string | null
}

/**
 * Derive the recovery view from one Link's durable checkpoints, mirroring the
 * recovery table:
 *
 * - reserved → continue-creation (+ cancel)
 * - creating → recheck (reconcile; idempotent create decides published vs new)
 * - published pristine → start-handoff (+ open-target)
 * - published diverged → open-target + clone (NEVER inject)
 * - terminal create conflict → clone
 * - delivery uncertain → redeliver (+ open-target) with a risk note
 * - relation active → open-thread only
 */
export function deriveRecoveryView(link: ThreadLink): RecoveryView {
  const titleWarning = link.title.phase === 'failed' || link.title.phase === 'unknown'
    ? `会话标题未按预期生效（${link.title.phase === 'failed' ? '改名失败' : '结果未知'}），不影响交接`
    : null

  if (link.relation === 'abandoned' || link.target.phase === 'abandoned') {
    return {
      primary: null,
      secondary: [],
      titleWarning,
      deliveryWarning: null,
      summary: '该交接授权已取消',
    }
  }

  if (link.relation === 'active') {
    return {
      primary: 'open-thread',
      secondary: [],
      titleWarning,
      deliveryWarning: null,
      summary: null,
    }
  }

  if (link.target.phase === 'diverged') {
    return {
      primary: 'open-target',
      secondary: ['clone'],
      titleWarning,
      deliveryWarning: null,
      summary: '目标会话已产生本交接之外的输入，不会再向其注入 Handoff',
    }
  }

  if (link.failure?.recovery === 'clone') {
    return {
      primary: 'clone',
      secondary: ['open-target'],
      titleWarning,
      deliveryWarning: null,
      summary: `创建冲突：${link.failure.code}`,
    }
  }

  switch (link.target.phase) {
    case 'reserved':
      return {
        primary: 'continue-creation',
        secondary: ['cancel'],
        titleWarning,
        deliveryWarning: null,
        summary: null,
      }
    case 'creating':
      return {
        primary: 'recheck',
        secondary: link.failure === null ? [] : ['cancel'],
        titleWarning,
        deliveryWarning: null,
        summary: link.failure === null ? null : `上次创建未完成：${link.failure.code}`,
      }
    case 'published':
      break
    default:
      return {
        primary: null,
        secondary: [],
        titleWarning,
        deliveryWarning: null,
        summary: null,
      }
  }

  // target published, relation pending.
  if (link.delivery.phase === 'uncertain') {
    return {
      primary: 'redeliver',
      secondary: ['open-target'],
      titleWarning,
      deliveryWarning: '上一次投递的落盘结果未知；重新投递会先核对目标日志，仅缺失的消息才会以新 ID 重投',
      summary: '交接消息可能已送达，等待确认后重投',
    }
  }
  return {
    primary: 'start-handoff',
    secondary: ['open-target'],
    titleWarning,
    deliveryWarning: null,
    summary: link.delivery.phase === 'submitting' ? '上次交接中断，将继续核对后完成' : null,
  }
}
