import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildMemoryTree } from '../src/client/tree.ts'
import type { MemoryTreeSnapshot } from '../src/manager-contract.ts'

const files: MemoryTreeSnapshot['files'] = [
  { path: 'views/user-profile.md', name: 'user-profile.md', label: 'user-profile', kind: 'view', bytes: 1, mtimeMs: 1, hash: 'a' },
  {
    path: 'scopes/user/semantic/mem_b.md', name: 'mem_b.md', label: 'z-last', kind: 'memory', bytes: 2, mtimeMs: 2, hash: 'b',
    record: { id: 'mem_b', scope: 'user', kind: 'semantic', status: 'active', privacy: 'normal', quarantined: false },
  },
  {
    path: 'scopes/user/semantic/mem_a.md', name: 'mem_a.md', label: 'a-first', kind: 'memory', bytes: 2, mtimeMs: 2, hash: 'c',
    record: { id: 'mem_a', scope: 'user', kind: 'semantic', status: 'candidate', privacy: 'normal', quarantined: false },
  },
]

test('flat display files become stable folders with labeled leaf rows', () => {
  const tree = buildMemoryTree(files)
  assert.deepEqual(tree.map(node => node.path), ['scopes', 'views'])
  const scopes = tree[0]
  assert.equal(scopes?.type, 'folder')
  if (scopes?.type !== 'folder') return
  const user = scopes.children[0]
  assert.equal(user?.type, 'folder')
  if (user?.type !== 'folder') return
  const semantic = user.children[0]
  assert.equal(semantic?.type, 'folder')
  if (semantic?.type !== 'folder') return
  assert.deepEqual(semantic.children.map(node => node.name), ['a-first', 'z-last'])
})
