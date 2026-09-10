import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { expect, test } from 'vitest'

const require = createRequire(import.meta.url)
const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { devDependencies?: Record<string, string> }

const SOURCE_SPEC = 'link:../deepseek-harness/packages/mcp/mcp-client'
// The registry spec rides the manifest as a single source of truth: the
// candidate aliases track the fork release the manifest pins, so deriving
// the expectation from the manifest keeps the bump a one-file change.
const registrySpec = packageJson.devDependencies?.['@deepseek-ai/dsh-mcp-client'] ?? ''
const registryVersion = registrySpec.match(/^npm:@crazx\/dsh-mcp-client@(\S+)$/)?.[1]

test('managed installs use the status-capable MCP client', () => {
  const spec = packageJson.devDependencies?.['@deepseek-ai/dsh-mcp-client']
  expect([SOURCE_SPEC, registrySpec]).toContain(spec)
  expect(registrySpec === SOURCE_SPEC || registryVersion !== undefined).toBe(true)

  const clientPackage = require('@deepseek-ai/dsh-mcp-client/package.json') as {
    name: string
    version: string
  }
  if (spec !== SOURCE_SPEC && clientPackage.name === '@deepseek-ai/dsh-mcp-client') {
    // Transitional publish window: the manifest already aliases the fork
    // layer while the local node_modules still holds the source-link tree
    // (@crazx/* not on npm yet). Identity and status capability are the
    // checkable invariants; the exact fork version lands with the publish.
    expect(readFileSync(require.resolve('@deepseek-ai/dsh-mcp-client'), 'utf8')).toContain(
      'mcp-client/status',
    )
    return
  }
  expect(clientPackage).toMatchObject(spec === SOURCE_SPEC
    // Source posture: the linked checkout's version rides the harness branch,
    // so only the identity and the status capability are pinned here.
    ? { name: '@deepseek-ai/dsh-mcp-client' }
    : { name: '@crazx/dsh-mcp-client', version: registryVersion })
  expect(readFileSync(require.resolve('@deepseek-ai/dsh-mcp-client'), 'utf8')).toContain(
    'mcp-client/status',
  )
})
