/** Bilingual copy for the settings-card effort editor (namespace `settings.modelEfforts`). */

/** Every dictionary key this plugin registers. */
export type ModelEffortsLocaleKey =
  | 'tooltip'
  | 'notEditable'
  | 'writing'
  | 'writeFailed'
  | 'apply'
  | 'modeInherit'
  | 'modeFalse'
  | 'modeLevels'
  | 'stateUndeclared'
  | 'stateFalse'
  | 'stateLevels'
  | 'stateUnknown'
  | 'levelOffNote'
  | 'wirePlaceholder'
  | 'wireInvalid'
  | 'compatZai'
  | 'compatZaiHint'
  | 'noChange'

/** The zh dictionary; key order mirrors {@link ModelEffortsLocaleKey}. */
export const zh: Record<ModelEffortsLocaleKey, string> = {
  tooltip: '推理档位：{state}',
  notEditable: '该行未保存或由目录提供，不可在此编辑',
  writing: '写入中…',
  writeFailed: '写入失败：{message}',
  apply: '应用',
  modeInherit: '跟随默认',
  modeFalse: '不推理',
  modeLevels: '自定义档位',
  stateUndeclared: '跟随默认',
  stateFalse: '已钉死关闭',
  stateLevels: '{count} 个档位',
  stateUnknown: '未知',
  levelOffNote: '留空 = 支持「关」但不发送参数',
  wirePlaceholder: '默认同名',
  wireInvalid: '所选档位需要非空的线上值（off 可留空）',
  compatZai: 'Z.ai 线缆格式',
  compatZaiHint: 'thinking + reasoning_effort',
  noChange: '没有需要写入的变更',
}

/** The en dictionary. */
export const en: Record<ModelEffortsLocaleKey, string> = {
  tooltip: 'Reasoning efforts: {state}',
  notEditable: 'Unsaved draft or catalog-served row — not editable here',
  writing: 'Writing…',
  writeFailed: 'Write failed: {message}',
  apply: 'Apply',
  modeInherit: 'Provider default',
  modeFalse: 'No reasoning',
  modeLevels: 'Custom levels',
  stateUndeclared: 'provider default',
  stateFalse: 'pinned off',
  stateLevels: '{count} levels',
  stateUnknown: 'unknown',
  levelOffNote: 'empty = supported "off" sends no parameter',
  wirePlaceholder: 'same as level',
  wireInvalid: 'Selected levels need a non-empty wire value (off may stay empty)',
  compatZai: 'Z.ai wire format',
  compatZaiHint: 'thinking + reasoning_effort',
  noChange: 'Nothing to write',
}
