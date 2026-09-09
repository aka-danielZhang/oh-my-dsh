/**
 * Bilingual copy for the usage-stats settings page (Chinese first).
 *
 * @module dsh-usage-stats/client/locales
 */

export const zh = {
  'nav': '使用统计',
  'page.title': '使用统计',
  'page.intro': '统计本机所有会话的 Token 用量、活动热力图与模型分布。数据采集自会话日志，不包含费用估算。',
  'action.refresh': '刷新',
  'state.loading': '正在读取统计…',
  'state.error': '读取失败：{message}',
  'state.empty': '暂无数据——发起一次对话后这里就会出现统计。',
  'state.generated': '更新于 {time}',

  'card.totalTokens': '累计 Token',
  'card.peakTokens': '峰值 Token',
  'card.peakTokens.hint': '单次调用最大用量',
  'card.longestChat': '最长聊天时长',
  'card.currentStreak': '连续使用天数',
  'card.currentStreak.hint': '截至今天或昨天',
  'card.longestStreak': '最长连续天数',
  'card.unit.days': '天',
  'card.since': '自 {date} 起 · 活跃 {days} 天',

  'heatmap.title': 'Token 活动热力图',
  'heatmap.mode.daily': '每日',
  'heatmap.mode.weekly': '每周',
  'heatmap.mode.cumulative': '累计',
  'heatmap.legend.less': '少',
  'heatmap.legend.more': '多',
  'heatmap.cell.day': '{date} · {tokens}',
  'heatmap.cell.week': '自 {date} 的一周 · {tokens}',

  'range.title': '时间范围',
  'range.7': '近 7 天',
  'range.30': '近 30 天',

  'trend.title': '每日 Token 趋势',
  'trend.legend.total': '合计',

  'donut.title': '用量分布',
  'donut.dim.model': '按模型',
  'donut.dim.provider': '按供应商',
  'donut.empty': '所选范围内没有用量',
  'donut.share': '{share} · {tokens}',

  'format.tenThousand': '万',
  'format.million': 'M',
  'format.thousand': 'K',
  'format.unit.minute': '分钟',
  'format.unit.hour': '小时',
  'format.justNow': '刚刚',
  'format.minutesAgo': '{n} 分钟前',
  'format.hoursAgo': '{n} 小时前',
} as const

export const en = {
  'nav': 'Usage Stats',
  'page.title': 'Usage Stats',
  'page.intro': 'Token usage, activity heatmap, and model distribution across all local sessions. Collected from session logs; no cost estimates.',
  'action.refresh': 'Refresh',
  'state.loading': 'Loading statistics…',
  'state.error': 'Failed: {message}',
  'state.empty': 'No data yet — start a conversation and the stats will appear.',
  'state.generated': 'Updated {time}',

  'card.totalTokens': 'Total tokens',
  'card.peakTokens': 'Peak tokens',
  'card.peakTokens.hint': 'Largest single call',
  'card.longestChat': 'Longest session',
  'card.currentStreak': 'Current streak',
  'card.currentStreak.hint': 'Through today or yesterday',
  'card.longestStreak': 'Longest streak',
  'card.unit.days': 'days',
  'card.since': 'Since {date} · {days} active days',

  'heatmap.title': 'Token activity',
  'heatmap.mode.daily': 'Daily',
  'heatmap.mode.weekly': 'Weekly',
  'heatmap.mode.cumulative': 'Cumulative',
  'heatmap.legend.less': 'Less',
  'heatmap.legend.more': 'More',
  'heatmap.cell.day': '{date} · {tokens}',
  'heatmap.cell.week': 'Week of {date} · {tokens}',

  'range.title': 'Range',
  'range.7': 'Last 7 days',
  'range.30': 'Last 30 days',

  'trend.title': 'Daily token trend',
  'trend.legend.total': 'Total',

  'donut.title': 'Usage breakdown',
  'donut.dim.model': 'By model',
  'donut.dim.provider': 'By provider',
  'donut.empty': 'No usage in the selected range',
  'donut.share': '{share} · {tokens}',

  'format.tenThousand': 'w',
  'format.million': 'M',
  'format.thousand': 'K',
  'format.unit.minute': 'min',
  'format.unit.hour': 'h',
  'format.justNow': 'just now',
  'format.minutesAgo': '{n} min ago',
  'format.hoursAgo': '{n} h ago',
} as const

/** Every dictionary key. */
export type UsageStatsLocaleKey = keyof typeof zh
