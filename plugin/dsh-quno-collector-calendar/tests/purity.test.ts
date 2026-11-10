/**
 * Purity gate for a collector package: everything under src/ may reach the
 * Host package (`dsh-quno/src/*`) through `import type` only. A value import
 * would bundle a private copy of a Host class into lib/index.js, where
 * `instanceof` against the Host's own instance is always false — the defect
 * the 2026-11-10 collector review found in the installed tarballs.
 */

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { test } from 'node:test'

/** One import/export-from statement: clause is a name list, `* as X`, `X, {…}` or `{…}`. */
const STATIC = /^(?:import|export)\s+(type\s+)?(?:\{[^}]*\}|[\w*\s]+(?:,\s*\{[^}]*\})?)\s+from\s+'([^']+)'/gm
const DYNAMIC = /import\(\s*'([^']+)'/g

test('purity: src reaches the Host package through type-only imports', () => {
  const dir = new URL('../src/', import.meta.url)
  const offenders: string[] = []
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.ts')) continue
    const text = readFileSync(new URL(file, dir), 'utf8')
    for (const match of text.matchAll(STATIC)) {
      const specifier = match[2] ?? ''
      if (specifier.includes('dsh-quno/src/') && match[1] === undefined) {
        offenders.push(`${file}: ${(match[0].split('\n')[0] ?? '').trim()}`)
      }
    }
    for (const match of text.matchAll(DYNAMIC)) {
      if ((match[1] ?? '').includes('dsh-quno/src/')) offenders.push(`${file}: dynamic ${match[0]}`)
    }
  }
  assert.deepEqual(offenders, [], 'a value import from the Host package bundles a private copy')
})

test('purity: the gate itself catches a value import (self-check)', () => {
  const sample = "import type { A } from '../../dsh-quno/src/types.ts'\nimport { QunoIngressError } from '../../dsh-quno/src/ingress.ts'\nexport const x = 1\n"
  const hits = [...sample.matchAll(STATIC)].filter(match => (match[2] ?? '').includes('dsh-quno/src/') && match[1] === undefined)
  assert.equal(hits.length, 1)
  assert.match(hits[0]?.[0] ?? '', /QunoIngressError/)
})
