import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { MemoryCatalog } from '../src/catalog.ts'
import { parseScopeFile, serializeScopeFile } from '../src/schema.ts'
import { writeFileAtomic } from '../src/atomic.ts'
import { resolveWorkspaceScope, ScopeError, parseScopeValue } from '../src/scope.ts'
import { scratchRoot } from './helpers/scratch.ts'

const WS = 'ws_01J5G0Z0Z0Z0Z0Z0Z0Z0Z0Z0Z0'

function projectDir(): string {
  return mkdtempSync(join(tmpdir(), 'ohmymemo-ws-'))
}

test('parseScopeValue accepts user and workspace:ws_<ulid> only', () => {
  assert.deepEqual(parseScopeValue('user'), { kind: 'user' })
  assert.deepEqual(parseScopeValue(`workspace:${WS}`), { kind: 'workspace', wsId: WS })
  assert.equal(parseScopeValue('workspace:not-valid'), undefined)
  assert.equal(parseScopeValue('team'), undefined)
})

test('workspace resolution reuses the scope registered for the canonical path', async () => {
  const root = scratchRoot()
  const project = projectDir()
  const catalog = new MemoryCatalog()
  const relPath = `scopes/workspaces/${WS}/scope.yaml`
  writeFileAtomic(join(root, ...relPath.split('/')), serializeScopeFile({
    schema: 'ohmymemo-scope/v1',
    id: WS,
    dsh_workspace_id: null,
    canonical_path: await real(project),
    created_at: '2026-09-03T00:00:00.000Z',
    updated_at: '2026-09-03T00:00:00.000Z',
  }))
  // register via a mini-scan equivalent: parse directly into the catalog
  const { scanStore } = await import('../src/scan.ts')
  const scanned = scanStore(root, { maxRecordBytes: 16384 })
  const resolution = resolveWorkspaceScope({ root, catalog: scanned.catalog, cwd: project, create: false })
  assert.equal(resolution.wsId, WS)
  assert.equal(resolution.created, false)
})

test('dsh_workspace_id association wins over path matching (moved directories)', async () => {
  const root = scratchRoot()
  const oldPath = projectDir()
  const newPath = projectDir()
  const catalog = new MemoryCatalog()
  const register = (wsId: string, canonicalPath: string, dshId: string | null): void => {
    const relPath = `scopes/workspaces/${wsId}/scope.yaml`
    writeFileAtomic(join(root, ...relPath.split('/')), serializeScopeFile({
      schema: 'ohmymemo-scope/v1',
      id: wsId,
      dsh_workspace_id: dshId,
      canonical_path: canonicalPath,
      created_at: '2026-09-03T00:00:00.000Z',
      updated_at: '2026-09-03T00:00:00.000Z',
    }))
    const parsed = parseScopeFile(readFileSync(join(root, ...relPath.split('/')), 'utf8'))
    catalog.registerScope({ scope: parsed.scope!, wsId, relPath })
  }
  register(WS, await real(oldPath), null)
  const moved = 'ws_01J5G0Z0Z0Z0Z0Z0Z0Z0Z0Z0Z1'
  register(moved, '/somewhere/else', 'dsh-ws-42')

  const resolution = resolveWorkspaceScope({
    root,
    catalog,
    cwd: oldPath,
    create: false,
    registry: { resolveByPath: (path: string) => (path.includes(oldPath.split('/').pop()!) ? { id: 'dsh-ws-42' } : undefined) },
  })
  assert.equal(resolution.wsId, moved, 'registry association beats stale path registration')
})

test('resolution creates a fresh scope only when asked', async () => {
  const root = scratchRoot()
  const project = projectDir()
  const catalog = new MemoryCatalog()
  assert.throws(
    () => resolveWorkspaceScope({ root, catalog, cwd: project, create: false }),
    (error: unknown) => {
      assert.ok(error instanceof ScopeError)
      assert.equal(error.code, 'OHMYMEMO_WORKSPACE_UNKNOWN')
      return true
    },
  )
  const created = resolveWorkspaceScope({ root, catalog, cwd: project, create: true })
  assert.equal(created.created, true)
  assert.match(created.wsId, /^ws_[0-9A-HJKMNP-TV-Z]{26}$/)
  assert.ok(existsSync(join(root, 'scopes', 'workspaces', created.wsId, 'scope.yaml')))
  assert.ok(existsSync(join(root, 'scopes', 'workspaces', created.wsId, 'semantic')))
  const again = resolveWorkspaceScope({ root, catalog, cwd: project, create: true })
  assert.equal(again.created, false)
  assert.equal(again.wsId, created.wsId)
})

test('a cwd that cannot be canonicalized refuses instead of guessing', () => {
  const root = scratchRoot()
  assert.throws(
    () => resolveWorkspaceScope({ root, catalog: new MemoryCatalog(), cwd: join(root, 'does', 'not', 'exist'), create: true }),
    (error: unknown) => {
      assert.ok(error instanceof ScopeError)
      assert.equal(error.code, 'OHMYMEMO_NO_CANONICAL_PATH')
      return true
    },
  )
})

async function real(path: string): Promise<string> {
  const { realpathSync } = await import('node:fs')
  return realpathSync(path)
}
