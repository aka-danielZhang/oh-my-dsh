/**
 * Message and conversation adapters between the yzj-cli JSON shapes and the
 * Sense's normalized model.
 *
 * Time policy (v2): timestamps arrive without a timezone (verified shape
 * `2026-10-29 21:29:52.194`). They are interpreted explicitly as
 * Asia/Shanghai (+08:00, no DST) — never through the host's local timezone.
 * Strings carrying an explicit offset keep their own semantics.
 *
 * Mention policy (v2): only the TOP-LEVEL `param.desc[]` entries with
 * `type: "at"` count as @ evidence. `extFields` may contain selfOpenId for
 * reactions/edits — that is never a mention. Nothing is inferred from reply
 * fields or notification summaries.
 *
 * @module dsh-quno-sense-yzj/messages
 */

/** Cloud之家 business timezone for naive timestamps; China has no DST. */
const NAIVE_TZ_OFFSET = '+08:00'

/** One normalized chat message. */
export interface YzjMessage {
  readonly msgId: string
  readonly groupId: string
  readonly groupName: string | null
  readonly fromOpenId: string | null
  readonly msgType: string | null
  readonly text: string | null
  /** Epoch ms; null = absent or unparseable (treated as "time unknown"). */
  readonly sentAt: number | null
  /**
   * Verified @ targets from top-level `param.desc[]`. `null` = the param/desc
   * shape was malformed and relevance is UNKNOWN (a coverage gap); an empty
   * array is a verified "no @ evidence" — a normal non-hit.
   */
  readonly atMentions: readonly string[] | null
}

/** One recent conversation as `im group recent` describes it. */
export interface RecentConversation {
  readonly conversationId: string
  readonly name: string
  /** 1 = private chat, 2 = group chat, 3 = assistant, 8 = system notice. */
  readonly groupType: number | null
  readonly lastMsgId: string | null
  readonly lastActivityAt: number | null
}

/** Timestamps arrive as epoch millis, epoch seconds, or (naive) local strings. */
export function parseSentAt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1e12 ? value : value > 1e9 ? value * 1000 : null
  }
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed === '') return null
  if (/^\d+$/.test(trimmed)) {
    const numeric = Number(trimmed)
    return numeric > 1e12 ? numeric : numeric > 1e9 ? numeric * 1000 : null
  }
  if (hasExplicitOffset(trimmed)) {
    const parsed = Date.parse(trimmed)
    return Number.isFinite(parsed) ? parsed : null
  }
  const naive = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?$/.exec(trimmed)
  if (naive !== null) {
    const [, year, month, day, hour = '00', minute = '00', second = '00', frac = ''] = naive
    const millis = frac === '' ? '' : `.${frac.padEnd(3, '0').slice(0, 3)}`
    const parsed = Date.parse(`${year}-${month}-${day}T${hour}:${minute}:${second}${millis}${NAIVE_TZ_OFFSET}`)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

/** Whether the string carries an explicit UTC designator or numeric offset. */
function hasExplicitOffset(text: string): boolean {
  return /(?:Z|z|[+-]\d{2}:?\d{2})$/.test(text)
}

/**
 * Extract the @ evidence from one message's top-level `param`. `null` means
 * the structure was malformed (relevance unknown); missing param and missing
 * or non-array desc count as verified "no @".
 */
export function extractAtMentions(item: Record<string, unknown>): readonly string[] | null {
  const param = item['param']
  if (param === null || param === undefined) return []
  if (typeof param !== 'object' || Array.isArray(param)) return null
  const record = param as Record<string, unknown>
  const desc = record['desc']
  if (desc === null || desc === undefined) return []
  if (!Array.isArray(desc)) return null
  const targets: string[] = []
  for (const entry of desc) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return null
    const record = entry as Record<string, unknown>
    if (record['type'] !== 'at') continue
    const data = record['data']
    if (typeof data !== 'string' || data.trim() === '') return null
    targets.push(data)
  }
  return targets
}

function firstString(item: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = item[key]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  return null
}

function optionalNumber(item: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = item[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return null
}

/** The raw entries of one message page plus how many objects were invalid. */
export interface MessagePage {
  readonly messages: readonly YzjMessage[]
  /** Entries that could not yield a stable msgId — the traversal boundary is unknown. */
  readonly invalid: number
}

/**
 * Normalize one raw message list into messages. Entries without a stable
 * msgId are NOT silently dropped: the caller must treat the page boundary as
 * unknown and never advance a cursor past them.
 */
export function parseMessagePage(list: readonly unknown[], fallbackGroupId: string): MessagePage {
  const messages: YzjMessage[] = []
  let invalid = 0
  for (const raw of list) {
    if (typeof raw !== 'object' || raw === null) {
      invalid += 1
      continue
    }
    const item = raw as Record<string, unknown>
    const msgId = firstString(item, ['msgId', 'messageId', 'id'])
    if (msgId === null) {
      invalid += 1
      continue
    }
    const rawText = typeof item['content'] === 'string' ? item['content'] : typeof item['text'] === 'string' ? item['text'] : null
    messages.push({
      msgId,
      groupId: firstString(item, ['groupId', 'chatId', 'conversationId']) ?? fallbackGroupId,
      groupName: firstString(item, ['groupName', 'chatName']),
      fromOpenId: firstString(item, ['fromOpenId', 'senderOpenId', 'senderId', 'from']),
      msgType: firstString(item, ['msgType', 'messageType', 'type']),
      text: rawText === null || rawText.trim() === '' ? null : rawText,
      sentAt: parseSentAt(item['sendTime'] ?? item['sendAt'] ?? item['createTime'] ?? item['timestamp'] ?? item['time']),
      atMentions: extractAtMentions(item),
    })
  }
  return { messages, invalid }
}

/** Normalize one raw `im group recent` list. Entries without an id are skipped. */
export function parseRecentConversations(list: readonly unknown[]): RecentConversation[] {
  const out: RecentConversation[] = []
  for (const raw of list) {
    if (typeof raw !== 'object' || raw === null) continue
    const item = raw as Record<string, unknown>
    const conversationId = firstString(item, ['groupId', 'chatId', 'conversationId'])
    if (conversationId === null) continue
    out.push({
      conversationId,
      name: firstString(item, ['groupName', 'chatName', 'name']) ?? conversationId,
      groupType: optionalNumber(item, ['groupType']),
      lastMsgId: firstString(item, ['lastMsgId', 'lastMessageId']),
      lastActivityAt: parseSentAt(item['lastMsgSendTime'] ?? item['lastUpdateTime']),
    })
  }
  return out
}

/** Page direction, derived from timestamps only (never from a guess). */
export function orderOf(messages: readonly YzjMessage[]): 'asc' | 'desc' | 'unknown' {
  if (messages.length < 2) return 'asc'
  const stamps = messages.map(message => message.sentAt)
  if (stamps.some(time => time === null)) return 'unknown'
  let ascending = true
  let descending = true
  for (let index = 1; index < stamps.length; index += 1) {
    const previous = stamps[index - 1] as number
    const current = stamps[index] as number
    if (current < previous) ascending = false
    if (current > previous) descending = false
  }
  if (ascending) return 'asc'
  if (descending) return 'desc'
  return 'unknown'
}

/**
 * Turn one recent conversation into a selectable option. Only `groupType: 2`
 * (multi-member group chat) is collectable as a whitelist entry; everything
 * else is shown but disabled with the real reason. Private chats
 * (`groupType: 1`) are collected automatically in focused mode — selecting
 * them into a group whitelist is not a thing.
 */
export function toGroupOption(group: RecentConversation): {
  readonly value: string
  readonly label: string
  readonly description?: string
  readonly disabled?: boolean
  readonly disabledReason?: string
} {
  const base = { value: group.conversationId, label: group.name }
  const detail = group.lastActivityAt === null ? '' : ` · 最近 ${new Date(group.lastActivityAt).toLocaleString('zh-CN')}`
  if (group.groupType === 2) return { ...base, description: `群聊${detail}` }
  if (group.groupType === 1) {
    return { ...base, description: `私聊${detail}`, disabled: true, disabledReason: '私聊无需选择，聚焦模式自动接收' }
  }
  if (group.groupType === 3) {
    return { ...base, description: '助手 / 应用会话', disabled: true, disabledReason: '助手类会话不是群聊' }
  }
  if (group.groupType === 8) {
    return { ...base, description: '系统通知', disabled: true, disabledReason: '系统通知不是群聊' }
  }
  return {
    ...base,
    description: group.groupType === null ? '未知类型' : `未识别的会话类型（${String(group.groupType)}）`,
    disabled: true,
    disabledReason: '无法确认这是多人群聊',
  }
}
