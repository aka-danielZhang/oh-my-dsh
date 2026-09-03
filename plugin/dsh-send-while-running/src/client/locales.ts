/**
 * Dictionary namespace owned by this plugin: the stop button's accessible
 * label, mirroring ui-conversation's 'input.stop' copy in both locales.
 */
export const zh = {
  'stop.label': '停止',
} as const

export const en = {
  'stop.label': 'Stop',
} as const

export type SendWhileRunningKey = keyof typeof zh
