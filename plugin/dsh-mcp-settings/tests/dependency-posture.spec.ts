import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { expect, test } from 'vitest'

const require = createRequire(import.meta.url)
const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { devDependencies?: Record<string, string> }

const SOURCE_SPEC = 'link:../deepseek-harness/packages/mcp/mcp-client'
// The official 0.2.2-rc.3 client natively carries the status surface the
// manager consumes (`connectionStatusOf`); the fork's `mcp-client/status`
// event retired with the 0.2.2-rc.3+zw.1 merge. The manifest pins the official
// baseline (or the source link for debug posture) and the resolved build must
// expose that surface.
const registrySpec = packageJson.devDependencies?.['@deepseek-ai/dsh-mcp-client'] ?? ''

test('managed installs use the status-capable MCP client', () => {
  const spec = packageJson.devDependencies?.['@deepseek-ai/dsh-mcp-client']
  expect([SOURCE_SPEC, registrySpec]).toContain(spec)
  // Identity: a link: posture resolves the checkout (original scope); the
  // registry posture resolves the official package at the pinned baseline.
  const clientPackage = require('@deepseek-ai/dsh-mcp-client/package.json') as {
    name: string
    version: string
  }
  expect(clientPackage.name).toBe('@deepseek-ai/dsh-mcp-client')
  if (spec !== SOURCE_SPEC) expect(clientPackage.version).toBe(spec)
  // Capability: the official status face the manager binds per spawned fiber.
  expect(readFileSync(require.resolve('@deepseek-ai/dsh-mcp-client'), 'utf8')).toContain(
    'connectionStatusOf',
  )
})
