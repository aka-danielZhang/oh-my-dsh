/**
 * Bilingual copy for the usage-stats settings page (Chinese first). Every
 * product-visible string the React tree renders lives here or behind the
 * formatter profile in ./format.ts — chart components carry no inline copy.
 * Number/date units (万/亿, K/M/B, 分钟/min, month names) belong to the
 * formatter profile, not to this dictionary.
 *
 * @module dsh-usage-stats/client/locales
 */

export const zh = {
  'nav': '使用统计',
  'page.title': '使用统计',
  'page.intro': '本机所有会话的 Token 用量与调用表现。数据采集自会话日志，不含费用估算。',
  'action.refresh': '刷新',
  'action.retry': '重试',
  'state.loading': '正在读取统计…',
  'state.error': '读取失败：{message}',
  'state.empty': '暂无数据——发起一次对话后这里就会出现统计。',
  'state.refreshed': '统计已刷新。',

  'meta.line': '更新于 {time} · 自 {date} 起 · 活跃 {days} 天',

  'summary.totalTokens': '累计 Token',
  'summary.totalTokens.hint': '{calls} 次调用',
  'summary.cacheHit': '平均缓存命中',
  'summary.cacheHit.hint': '计费输入',
  'summary.speed': '平均输出速度',
  'summary.speed.hint': '端到端',
  'summary.call': '平均调用时长',
  'summary.call.hint': '调用开始 → 回复完成',

  'heatmap.title': 'Token 活动热力图',
  'heatmap.mode.daily': '每日',
  'heatmap.mode.weekly': '每周',
  'heatmap.legend.less': '少',
  'heatmap.legend.more': '多',
  'heatmap.cell.day': '{date}',
  'heatmap.cell.week': '{date} 当周',
  'heatmap.cell.detail': '{tokens} · {calls} 轮',
  'heatmap.wd.mon': '一',
  'heatmap.wd.wed': '三',
  'heatmap.wd.fri': '五',
  'heatmap.desc': '最近一年每天的 Token 用量热力图，颜色越深用量越大。',

  'range.title': '时间范围',
  'range.7': '近 7 天',
  'range.30': '近 30 天',
  'range.custom': '自定义',
  'range.from': '开始日期',
  'range.to': '结束日期',
  'range.invalid': '开始日期不能晚于结束日期。',
  'range.missing': '请补全开始与结束日期。',
  'range.tooLong': '自定义范围最多 120 天（当前 {days} 天）。',

  'trend.title': '按日 Token 趋势',
  'trend.desc': '所选时间范围内，各模型的每日 Token 用量趋势。',
  'trend.empty': '所选范围内没有用量。',
  'series.other': '其他',

  'quality.title': '模型质量',
  'quality.desc': '按模型对比缓存命中率和平均输出速度。',
  'quality.cacheHit': '缓存命中',
  'quality.speed': '输出速度',
  'quality.speedLegend': '输出速度 tok/s',

  'donut.title': '模型用量',
  'donut.desc': '所选范围内各模型的 Token 占比圆环与排行。',
  'donut.empty': '所选范围内没有用量。',
  'donut.total': '范围总量',
} as const

export const en = {
  'nav': 'Usage Stats',
  'page.title': 'Usage Stats',
  'page.intro': 'Token usage and call performance across all local sessions. Collected from session logs; no cost estimates.',
  'action.refresh': 'Refresh',
  'action.retry': 'Retry',
  'state.loading': 'Loading statistics…',
  'state.error': 'Failed: {message}',
  'state.empty': 'No data yet — start a conversation and the stats will appear.',
  'state.refreshed': 'Statistics refreshed.',

  'meta.line': 'Updated {time} · Since {date} · {days} active days',

  'summary.totalTokens': 'Total tokens',
  'summary.totalTokens.hint': '{calls} calls',
  'summary.cacheHit': 'Avg cache hit',
  'summary.cacheHit.hint': 'of billed input',
  'summary.speed': 'Avg output rate',
  'summary.speed.hint': 'end-to-end',
  'summary.call': 'Avg call duration',
  'summary.call.hint': 'Call start to response complete',

  'heatmap.title': 'Token activity heatmap',
  'heatmap.mode.daily': 'Daily',
  'heatmap.mode.weekly': 'Weekly',
  'heatmap.legend.less': 'Less',
  'heatmap.legend.more': 'More',
  'heatmap.cell.day': '{date}',
  'heatmap.cell.week': 'Week of {date}',
  'heatmap.cell.detail': '{tokens} · {calls} turns',
  'heatmap.wd.mon': 'Mon',
  'heatmap.wd.wed': 'Wed',
  'heatmap.wd.fri': 'Fri',
  'heatmap.desc': 'Heatmap of daily token usage over the last year; darker means more.',

  'range.title': 'Range',
  'range.7': 'Last 7 days',
  'range.30': 'Last 30 days',
  'range.custom': 'Custom',
  'range.from': 'Start date',
  'range.to': 'End date',
  'range.invalid': 'The start date must not be after the end date.',
  'range.missing': 'Fill in both the start and end dates.',
  'range.tooLong': 'Custom ranges span at most 120 days (currently {days}).',

  'trend.title': 'Daily token trend',
  'trend.desc': 'Daily token usage by model over the selected range.',
  'trend.empty': 'No usage in the selected range.',
  'series.other': 'Other',

  'quality.title': 'Model quality',
  'quality.desc': 'Cache hit rate and average output rate by model.',
  'quality.cacheHit': 'Cache hit',
  'quality.speed': 'Output rate',
  'quality.speedLegend': 'Output rate tok/s',

  'donut.title': 'Model usage',
  'donut.desc': 'Donut and ranking of each model’s token share over the selected range.',
  'donut.empty': 'No usage in the selected range.',
  'donut.total': 'Range total',
} as const

/** Every dictionary key. */
export type UsageStatsLocaleKey = keyof typeof zh
