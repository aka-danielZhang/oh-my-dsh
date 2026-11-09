import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { CollectorFieldWire } from '../src/api-types.ts'
import { isConfigured, sourceSummary, sourceSummaryText } from '../src/client/collector-summary.ts'
import type { QunoTranslate } from '../src/client/locales.ts'

const fields: readonly CollectorFieldWire[] = [
  { key: 'directory', label: '目录', type: 'path' },
  { key: 'file', label: '文件', type: 'path' },
  { key: 'url', label: '订阅地址', type: 'url' },
  { key: 'groupIds', label: '群组', type: 'multiselect', multiple: true },
  { key: 'token', label: '令牌', type: 'string', secret: true },
]

const t: QunoTranslate = (key => key === 'sourceSummaryCount' ? '{count} 项' : key) as QunoTranslate

test('isConfigured treats empty strings and empty arrays as unset', () => {
  assert.equal(isConfigured(undefined), false)
  assert.equal(isConfigured(null), false)
  assert.equal(isConfigured(''), false)
  assert.equal(isConfigured([]), false)
  assert.equal(isConfigured('x'), true)
  assert.equal(isConfigured(['a']), true)
  assert.equal(isConfigured(0), true)
  assert.equal(isConfigured(false), true)
})

test('a configured path wins over everything else', () => {
  const summary = sourceSummary({ directory: '/data/cal', file: '/x.ics', groupIds: ['a', 'b'] }, fields)
  assert.deepEqual(summary, { kind: 'value', label: '目录', value: '/data/cal' })
  assert.equal(sourceSummaryText(summary, '日历', t), '目录：/data/cal')
})

test('an empty path falls through to the next configured field', () => {
  const summary = sourceSummary({ directory: '', file: '/x.ics' }, fields)
  assert.deepEqual(summary, { kind: 'value', label: '文件', value: '/x.ics' })
  const url = sourceSummary({ url: 'https://example.com/feed.xml' }, fields)
  assert.deepEqual(url, { kind: 'value', label: '订阅地址', value: 'https://example.com/feed.xml' })
})

test('a multi-select list is reported as a count, not as raw ids', () => {
  const summary = sourceSummary({ groupIds: ['1', '2', '3'] }, fields)
  assert.deepEqual(summary, { kind: 'list', label: '群组', count: 3 })
  assert.equal(sourceSummaryText(summary, '云之家群聊', t), '群组：3 项')
})

test('an unknown shape falls back to the type name', () => {
  const summary = sourceSummary({ somethingElse: 'x' }, fields)
  assert.deepEqual(summary, { kind: 'none' })
  assert.equal(sourceSummaryText(summary, '订阅源', t), '订阅源')
})

test('a secret path field never enters the summary', () => {
  const secretPath: readonly CollectorFieldWire[] = [
    { key: 'vault', label: '保险库路径', type: 'path', secret: true },
    { key: 'groupIds', label: '群组', type: 'multiselect', multiple: true },
  ]
  const summary = sourceSummary({ vault: '/secret/place', groupIds: ['a'] }, secretPath)
  assert.deepEqual(summary, { kind: 'list', label: '群组', count: 1 })
  assert.equal(sourceSummaryText(summary, '类型', t).includes('/secret/place'), false)
})

test('a secret list field is skipped as well', () => {
  const secretList: readonly CollectorFieldWire[] = [
    { key: 'ids', label: '分组', type: 'multiselect', multiple: true, secret: true },
  ]
  assert.deepEqual(sourceSummary({ ids: ['a', 'b'] }, secretList), { kind: 'none' })
})
