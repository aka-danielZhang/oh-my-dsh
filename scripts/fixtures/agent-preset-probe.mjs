import { randomUUID } from 'node:crypto'

export const inject = ['appReady', 'agentPresets', 'agents', 'tools']

export function apply(ctx) {
  return ctx.appReady.onReady(() => {
    verify(ctx).then(
      presets => finish({ presets }),
      error => finish({ error: error.stack ?? String(error) }),
    )
  })
}

function finish(result) {
  // Emit inside Node so Windows also runs the CLI's graceful shutdown handler.
  process.stdout.write('DSH_PRESET_SMOKE_RESULT ' + JSON.stringify(result) + '\n', () => {
    process.emit('SIGTERM')
  })
}

async function verify(ctx) {
  const expected = ['standard', 'ptc', 'minimal', 'cordis']
  const roster = await ctx.agentPresets.list()
  const results = []
  for (const id of expected) {
    const preset = roster.find(row => row.id === id && row.trust === 'system')
    if (!preset) throw new Error(`Missing shipped preset: ${id}`)
    if (preset.broken !== undefined) throw new Error(`${id}: ${preset.broken}`)
    const handle = await ctx.agents.create({
      sessionId: randomUUID(),
      meta: { cwd: process.env.DSH_HOME },
      setup: async agentCtx => { await ctx.agentPresets.mount(agentCtx, id) },
    })
    try {
      const tools = ctx.tools.schemas(handle.agent).map(tool => tool.name)
      if (tools.length === 0) throw new Error(`${id}: no tools after mount`)
      if (id === 'cordis' && !tools.includes('cordis_inspect_list')) {
        throw new Error('cordis: missing cordis_inspect_list after mount')
      }
      results.push({ id, tools: tools.length })
    } finally {
      await handle.dispose()
    }
  }
  return results
}
