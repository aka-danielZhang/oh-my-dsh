/**
 * Integration tests over the REAL collaborator stack — fs-local provider,
 * the stock fs-observation-policy, ToolRuntime, and dsh-tool-fs — assembling
 * two separate Cordis contexts against one DSH_HOME to simulate a process
 * restart, exactly the amnesia this plugin heals.
 *
 * The scenario matrix:
 * - restart + unchanged file  → edit healed (the plugin's whole point)
 * - restart + changed file    → NOT healed, stock rejection stands
 * - fork lineage              → parent's evidence heals the child
 * - never observed            → stock rejection stands
 * @module dsh-fs-observation-log/tests/integration
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import FsLocal from '@deepseek-ai/dsh-fs-local'
import * as FsPolicy from '@deepseek-ai/dsh-fs-observation-policy'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import * as ObservationLog from '../src/index.ts'

const signal = new AbortController().signal
const scratchRoots: string[] = []
let previousDshHome: string | undefined

before(() => {
  previousDshHome = process.env.DSH_HOME
})

after(() => {
  if (previousDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousDshHome
  for (const dir of scratchRoots) rmSync(dir, { recursive: true, force: true })
})

/** One "process": a fresh Cordis context with the real filesystem stack plus this plugin. */
async function boot(home: string): Promise<Context> {
  process.env.DSH_HOME = home
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(FsLocal)
  await ctx.plugin(FsPolicy)
  await ctx.plugin(ToolFs)
  await ctx.plugin(ObservationLog)
  return ctx
}

let callCounter = 0
function call(ctx: Context, name: string, args: unknown, session: { id: string; parentSession?: string; cwd?: string }) {
  return ctx.tools.execute({
    signal,
    callId: ToolCallId(`call-${++callCounter}`),
    name,
    arguments: args,
    agent: { session: { header: session } } as never,
  })
}

function resultText(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter((block) => block.type === 'text').map((block) => block.text).join('')
}

/** A scratch workspace + DSH_HOME pair; the file under edit lives in the workspace. */
function scratch(): { home: string; file: string } {
  const home = mkdtempSync(join(tmpdir(), 'obs-log-home-'))
  const work = mkdtempSync(join(tmpdir(), 'obs-log-work-'))
  scratchRoots.push(home, work)
  const file = join(work, 'target.ts')
  writeFileSync(file, 'alpha\nbeta\ngamma\n', 'utf8')
  return { home, file }
}

test('restart + unchanged file: edit is healed through persisted evidence', async () => {
  const { home, file } = scratch()
  // Process 1: a normal read records the observation and the sidecar evidence.
  const first = await boot(home)
  const read = await call(first, 'read', { file_path: file }, { id: 's-restart' })
  assert.equal(read.isError, false, resultText(read as never))
  assert.equal(existsSync(join(home, 'fs-observation-log')), true)
  // Process 2: fresh context, same home — the stock WeakMap state is gone.
  const second = await boot(home)
  const edit = await call(second, 'edit', {
    file_path: file,
    old_string: 'beta',
    new_string: 'BETA',
  }, { id: 's-restart' })
  assert.equal(edit.isError, false, `edit should heal across restart, got: ${resultText(edit as never)}`)
})

test('restart + externally changed file: NOT healed, the stock rejection stands', async () => {
  const { home, file } = scratch()
  const first = await boot(home)
  await call(first, 'read', { file_path: file }, { id: 's-changed' })
  // The file changes after the remembered observation.
  writeFileSync(file, 'alpha\nCHANGED\ngamma\n', 'utf8')
  const second = await boot(home)
  const edit = await call(second, 'edit', {
    file_path: file,
    old_string: 'beta',
    new_string: 'BETA',
  }, { id: 's-changed' })
  assert.equal(edit.isError, true)
  assert.match(resultText(edit as never), /edit requires reading/)
})

test('fork lineage: the parent session\'s evidence heals the child', async () => {
  const { home, file } = scratch()
  const first = await boot(home)
  await call(first, 'read', { file_path: file }, { id: 's-parent' })
  // Process 2 with a forked session whose transcript contains the parent's read.
  const second = await boot(home)
  const edit = await call(second, 'edit', {
    file_path: file,
    old_string: 'gamma',
    new_string: 'GAMMA',
  }, { id: 's-child', parentSession: 's-parent' })
  assert.equal(edit.isError, false, `fork child edit should heal via lineage, got: ${resultText(edit as never)}`)
})

test('a target never observed by anyone in the lineage still rejects', async () => {
  const { home, file } = scratch()
  const ctx = await boot(home)
  const edit = await call(ctx, 'edit', {
    file_path: file,
    old_string: 'beta',
    new_string: 'BETA',
  }, { id: 's-stranger' })
  assert.equal(edit.isError, true)
  assert.match(resultText(edit as never), /edit requires reading/)
})

test('sidecars are per-session JSONL files under the plugin directory', async () => {
  const { home, file } = scratch()
  const first = await boot(home)
  await call(first, 'read', { file_path: file }, { id: 's-files' })
  const dir = join(home, 'fs-observation-log')
  const files = readdirSync(dir)
  assert.equal(files.length, 1)
  assert.match(files[0], /^s-files\.jsonl$/)
})
