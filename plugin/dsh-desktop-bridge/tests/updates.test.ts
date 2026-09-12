import assert from 'node:assert/strict'
import test from 'node:test'
import {
  decodeUpdateStatus, formatBytes, isUpdateBusy, isUpdateIndicatorVisible, notesFromStatus,
  statusFromCheck, updatePercent, visibleUpdateNotes,
} from '../src/client/updates.ts'

test('decodeUpdateStatus accepts download progress and rejects malformed totals', () => {
  assert.deepEqual(decodeUpdateStatus({
    phase: 'downloading',
    version: '0.3.0',
    downloaded: 4096,
    total: 8192,
  }), {
    phase: 'downloading',
    version: '0.3.0',
    downloaded: 4096,
    total: 8192,
  })
  assert.deepEqual(decodeUpdateStatus({
    phase: 'downloading',
    downloaded: -1,
    total: 0,
  }), {
    phase: 'downloading',
    version: '?',
    downloaded: 0,
  })
  assert.deepEqual(decodeUpdateStatus({ phase: 'future' }), {
    phase: 'failed',
    message: 'Unknown updater status',
  })
})

test('status helpers preserve check metadata and active phases', () => {
  assert.deepEqual(statusFromCheck(null), { phase: 'current' })
  assert.deepEqual(statusFromCheck({ version: '0.3.0', notes: 'fixes' }), {
    phase: 'available',
    version: '0.3.0',
    notes: 'fixes',
  })
  assert.equal(isUpdateBusy({ phase: 'checking' }), true)
  assert.equal(isUpdateBusy({ phase: 'preparing', version: '0.3.0' }), true)
  assert.equal(isUpdateBusy({ phase: 'available', version: '0.3.0', notes: '' }), false)
  assert.deepEqual(decodeUpdateStatus({ phase: 'ready', version: '0.3.0' }), {
    phase: 'ready',
    version: '0.3.0',
    notes: '',
  })
  assert.deepEqual(decodeUpdateStatus({
    phase: 'ready',
    version: '0.3.0',
    notes: '### Fixed\n- drift',
  }), {
    phase: 'ready',
    version: '0.3.0',
    notes: '### Fixed\n- drift',
  })
  assert.equal(isUpdateBusy({ phase: 'ready', version: '0.3.0', notes: '' }), false)
  assert.equal(notesFromStatus({ phase: 'ready', version: '0.3.0', notes: 'hi' }), 'hi')
  assert.equal(notesFromStatus({ phase: 'installing', version: '0.3.0' }), '')
  assert.equal(visibleUpdateNotes('See the release page for notes.'), '')
  assert.equal(visibleUpdateNotes('  ### Fixed\n- drift  '), '### Fixed\n- drift')
})

test('title-band visibility keeps background failures quiet', () => {
  assert.equal(isUpdateIndicatorVisible({ phase: 'failed', version: '0.3.0', message: 'offline' }), false)
  assert.equal(isUpdateIndicatorVisible({ phase: 'current' }), false)
  assert.equal(isUpdateIndicatorVisible({ phase: 'available', version: '0.3.0', notes: '' }), true)
  assert.equal(isUpdateIndicatorVisible({ phase: 'downloading', version: '0.3.0', downloaded: 0 }), true)
  assert.equal(isUpdateIndicatorVisible({ phase: 'ready', version: '0.3.0', notes: '' }), true)
})

test('updatePercent clamps completed downloads and needs a total', () => {
  assert.equal(updatePercent({ phase: 'downloading', version: 'x', downloaded: 25, total: 100 }), 25)
  assert.equal(updatePercent({ phase: 'downloading', version: 'x', downloaded: 110, total: 100 }), 100)
  assert.equal(updatePercent({ phase: 'downloading', version: 'x', downloaded: 25 }), undefined)
  assert.equal(updatePercent({ phase: 'current' }), undefined)
})

test('formatBytes keeps progress copy compact', () => {
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(1024), '1.0 KB')
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB')
  assert.equal(formatBytes(160 * 1024 * 1024), '160 MB')
})
