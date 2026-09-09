/**
 * Scope resolution: `user` is constant; workspace scopes bind a canonical
 * (realpath) directory to a stable `ws_<ulid>` via `scopes/workspaces/<ws>/
 * scope.yaml`. The path is an association attribute, never the identity —
 * moved directories require an explicit re-association.
 *
 * Resolution order (design doc):
 *
 * 1. realpath the cwd (no auto-create when it fails),
 * 2. prefer an existing `dsh_workspace_id` association (when a registry is
 *    available),
 * 3. reuse an existing scope registered for that canonical path,
 * 4. otherwise create a fresh scope registration — only when `create` is set.
 * @module dsh-ohmymemo/scope
 */

import { realpathSync } from 'node:fs'
import { ensureDir, writeFileAtomic } from './atomic.ts'
import { newScopeId } from './ids.ts'
import { serializeScopeFile } from './schema.ts'
import type { MemoryCatalog } from './catalog.ts'
import type { ScopeEntry } from './types.ts'

/** Optional DSH workspace registry seam (wired up in Phase 2). */
export interface WorkspaceRegistryLike {
  resolveByPath?(canonicalPath: string): { id?: string } | undefined
}

/** Result of resolving a workspace scope. */
export interface ScopeResolution {
  scope: string
  wsId: string
  canonicalPath: string
  created: boolean
}

/** Parse a scope value string. */
export function parseScopeValue(value: string): { kind: 'user' } | { kind: 'workspace'; wsId: string } | undefined {
  if (value === 'user') return { kind: 'user' }
  if (value.startsWith('workspace:')) {
    const wsId = value.slice('workspace:'.length)
    if (/^ws_[0-9A-HJKMNP-TV-Z]{26}$/.test(wsId)) return { kind: 'workspace', wsId }
  }
  return undefined
}

/** Resolve (and optionally create) the workspace scope for a cwd. */
export function resolveWorkspaceScope(options: {
  root: string
  catalog: MemoryCatalog
  cwd: string
  create: boolean
  registry?: WorkspaceRegistryLike
  now?: () => Date
}): ScopeResolution {
  const now = options.now ?? ((): Date => new Date())
  let canonicalPath: string
  try {
    canonicalPath = realpathSync(options.cwd)
  } catch (error) {
    throw new ScopeError(
      'OHMYMEMO_NO_CANONICAL_PATH',
      `workspace cwd ${options.cwd} cannot be canonicalized: ${(error as Error).message} — write to user scope or fix the path instead`,
    )
  }

  // 2. Existing dsh workspace association wins (stable identity across moves).
  if (options.registry !== undefined && typeof options.registry.resolveByPath === 'function') {
    const hit = options.registry.resolveByPath(canonicalPath)
    const dshId = hit?.id
    if (typeof dshId === 'string' && dshId.length > 0) {
      const entry = options.catalog.scopeByDshId(dshId)
      if (entry !== undefined) {
        return { scope: `workspace:${entry.wsId}`, wsId: entry.wsId, canonicalPath, created: false }
      }
    }
  }

  // 3. Reuse an existing registration for this canonical path.
  const byPath = options.catalog.scopeByPath(canonicalPath)
  if (byPath !== undefined) {
    return { scope: `workspace:${byPath.wsId}`, wsId: byPath.wsId, canonicalPath, created: false }
  }

  if (!options.create) {
    throw new ScopeError(
      'OHMYMEMO_WORKSPACE_UNKNOWN',
      `no memory scope is registered for ${canonicalPath} and create=false`,
    )
  }

  // 4. Create a fresh scope registration.
  const wsId = newScopeId()
  const at = now().toISOString()
  const scopeFile = {
    schema: 'ohmymemo-scope/v1' as const,
    id: wsId,
    dsh_workspace_id: options.registry?.resolveByPath?.(canonicalPath)?.id ?? null,
    canonical_path: canonicalPath,
    created_at: at,
    updated_at: at,
  }
  const relDir = `scopes/workspaces/${wsId}`
  ensureDir(`${options.root}/${relDir}/semantic`)
  ensureDir(`${options.root}/${relDir}/episodic`)
  ensureDir(`${options.root}/${relDir}/procedural`)
  writeFileAtomic(`${options.root}/${relDir}/scope.yaml`, serializeScopeFile(scopeFile))
  const entry: ScopeEntry = { scope: scopeFile, wsId, relPath: `${relDir}/scope.yaml` }
  options.catalog.registerScope(entry)
  return { scope: `workspace:${wsId}`, wsId, canonicalPath, created: true }
}

/** Scope resolution failure. */
export class ScopeError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'ScopeError'
    this.code = code
  }
}
