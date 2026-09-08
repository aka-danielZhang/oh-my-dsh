import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { expect, test } from 'vitest'

const require = createRequire(import.meta.url)
const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { devDependencies?: Record<string, string> }

test('source installs use the status-capable fork MCP client', () => {
  expect(packageJson.devDependencies?.['@deepseek-ai/dsh-mcp-client']).toBe(
    'npm:@crazx/dsh-mcp-client@0.1.2-rc.1.zw.1',
  )

  const clientPackage = require('@deepseek-ai/dsh-mcp-client/package.json') as {
    name: string
    version: string
  }
  expect(clientPackage).toMatchObject({
    name: '@crazx/dsh-mcp-client',
    version: '0.1.2-rc.1.zw.1',
  })
  expect(readFileSync(require.resolve('@deepseek-ai/dsh-mcp-client'), 'utf8')).toContain(
    'ctx.emit("mcp-client/status"',
  )
})
