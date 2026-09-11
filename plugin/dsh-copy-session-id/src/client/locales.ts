/**
 * Dictionary namespace owned by this plugin: the session actions menu (the
 * taken-over ellipsis button), its items, and the download status dialog.
 */
export const NS = 'copy-session-id'

export const zh = {
  'header.more': '会话操作',
  'menu.copy': '复制会话 ID',
  'menu.copied': '已复制会话 ID',
  'menu.download': '下载 Session 日志',
  'menu.downloading': '正在下载…',
  'status.preparingTitle': '正在准备 Session 日志…',
  'status.preparingDesc': '正在打包会话记录与附件，请稍候。',
  'status.successTitle': 'Session 日志已开始下载',
  'status.successDesc': '浏览器已开始保存 ZIP 文件，此窗口可关闭。',
  'status.errorTitle': 'Session 日志下载失败',
  'status.unknownError': '未知错误',
  'status.close': '关闭',
} as const

export const en = {
  'header.more': 'Session actions',
  'menu.copy': 'Copy Session ID',
  'menu.copied': 'Session ID copied',
  'menu.download': 'Download Session Log',
  'menu.downloading': 'Downloading…',
  'status.preparingTitle': 'Preparing Session log…',
  'status.preparingDesc': 'Packaging the session transcript and attachments.',
  'status.successTitle': 'Session log download started',
  'status.successDesc': 'The browser is saving the ZIP file; this dialog can be closed.',
  'status.errorTitle': 'Session log download failed',
  'status.unknownError': 'Unknown error',
  'status.close': 'Close',
} as const

export type CopySessionIdKey = keyof typeof zh
