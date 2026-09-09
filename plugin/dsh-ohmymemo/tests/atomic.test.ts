import assert from 'node:assert/strict'
import { readFileSync, statSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { ensureDir, hashFile, hashText, writeFileAtomic } from '../src/atomic.ts'
import { scratchRoot } from './helpers/scratch.ts'

test('writeFileAtomic publishes via rename with 0600 and leaves no temp files', () => {
  const root = scratchRoot()
  const target = join(root, 'scopes', 'user', 'semantic', 'mem_x.md')
  writeFileAtomic(target, 'hello\n')
  assert.equal(readFileSync(target, 'utf8'), 'hello\n')
  assert.equal(statSync(target).mode & 0o777, 0o600)
  const temps = readdirSync(join(root, 'scopes', 'user', 'semantic')).filter((name) => name.startsWith('.tmp-'))
  assert.deepEqual(temps, [])
})

test('writeFileAtomic overwrites atomically and creates parent dirs at 0700', () => {
  const root = scratchRoot()
  const target = join(root, 'tombstones', 'tomb_x.yaml')
  writeFileAtomic(target, 'v1\n')
  writeFileAtomic(target, 'v2\n')
  assert.equal(readFileSync(target, 'utf8'), 'v2\n')
  assert.equal(statSync(join(root, 'tombstones')).mode & 0o777, 0o700)
})

test('validate runs before publish: a throwing gate leaves the target untouched', () => {
  const root = scratchRoot()
  const target = join(root, 'record.md')
  writeFileAtomic(target, 'original\n')
  assert.throws(() =>
    writeFileAtomic(target, 'bad\n', {
      validate: (content: string) => {
        if (content === 'bad\n') throw new Error('refused')
      },
    }),
  )
  assert.equal(readFileSync(target, 'utf8'), 'original\n')
  assert.deepEqual(readdirSync(root).filter((name) => name.startsWith('.tmp-')), [])
})

test('hash helpers agree between memory and disk', () => {
  const root = scratchRoot()
  const target = join(root, 'f.txt')
  writeFileAtomic(target, 'payload')
  assert.equal(hashFile(target), hashText('payload'))
  assert.equal(hashFile(join(root, 'missing')), undefined)
})
