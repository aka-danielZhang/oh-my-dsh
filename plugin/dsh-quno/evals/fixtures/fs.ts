/**
 * Fixture FS: synthetic files with deterministic sentinel facts plus read-only
 * tools (`read` / `glob` / `grep`) scoped to the fixture directory, and a
 * real-but-inert `bash` global.
 *
 * The quno main preset hides all of these from the model's view and its guard
 * rejects invocations; the quno-task worker guard allows exactly the read-only
 * names. Cases assert both surfaces from the recorded tool lists.
 *
 * @module dsh-quno/evals/fixtures/fs
 */

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

/** Write the synthetic fixture tree and return its sentinel facts. */
export function writeFixtureFiles(root: string, files: readonly { readonly path: string; readonly content: string }[]): void {
  for (const file of files) {
    const target = resolve(root, file.path)
    if (!target.startsWith(resolve(root) + sep)) throw new Error(`fixture path escapes the fixture dir: ${file.path}`)
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, file.content, 'utf8')
  }
}

interface FixtureToolContext {
  tools: {
    register(tool: unknown): () => void
  }
}

/** Register the fixture-scoped read-only tools + inert bash on the eval ctx. */
export function registerFixtureTools(ctx: Context, root: string): void {
  const toolCtx = ctx as unknown as FixtureToolContext

  const inside = (path: string): string => {
    const target = resolve(root, path)
    if (target !== resolve(root) && !target.startsWith(resolve(root) + sep)) {
      throw new Error(`path escapes the fixture directory: ${path}`)
    }
    return target
  }

  toolCtx.tools.register(defineTool({
    name: 'read',
    description: '读取工作目录内的文本文件（评测环境只开放 fixture 目录）。',
    parameters: { path: { type: 'string', required: true, description: '相对路径' } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args) {
      const target = inside(String(args.path))
      return { text: readFileSync(target, 'utf8') }
    },
  }))

  toolCtx.tools.register(defineTool({
    name: 'glob',
    description: '按简单模式列出 fixture 目录内的文件（支持 * 与 **）。',
    parameters: { pattern: { type: 'string', required: true, description: '相对 glob 模式' } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { files: { type: 'array', items: { type: 'string' }, required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.files.join('\n') }],
    },
    async execute(args) {
      return {
        files: walk(root).filter((file) => {
          const rel = relative(root, file)
          // The worker's cwd is the session home; accept both bare and
          // 'fixture/'-prefixed patterns so the model's natural paths work.
          return matchPattern(rel, String(args.pattern)) || matchPattern(`fixture/${rel}`, String(args.pattern))
        }),
      }
    },
  }))

  toolCtx.tools.register(defineTool({
    name: 'grep',
    description: '在 fixture 目录内按文本搜索（返回文件、行号与该行）。',
    parameters: { query: { type: 'string', required: true, description: '要找的文本' } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { hits: { type: 'array', items: { type: 'string' }, required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.hits.join('\n') }],
    },
    async execute(args) {
      const query = String(args.query)
      const hits: string[] = []
      for (const file of walk(root)) {
        const lines = readFileSync(file, 'utf8').split('\n')
        for (const [index, line] of lines.entries()) {
          if (line.includes(query)) hits.push(`${relative(root, file)}:${String(index + 1)}: ${line}`)
        }
      }
      return { hits }
    },
  }))

  // A real global named `bash`, present in the registry but inert: the quno
  // preset hides it from the model and the routing guard refuses invocation.
  // This is what makes the tool-surface assertions structural instead of
  // prompt-hopeful.
  toolCtx.tools.register(defineTool({
    name: 'bash',
    description: '执行 shell 命令（评测环境：永远拒绝执行）。',
    parameters: { command: { type: 'string', required: true } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { message: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    async execute() {
      return { message: '评测环境不执行任何 shell 命令。' }
    },
  }))
}

function walk(root: string): string[] {
  const out: string[] = []
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const target = join(dir, entry)
      if (statSync(target).isDirectory()) visit(target)
      else out.push(target)
    }
  }
  if (existsDir(root)) visit(root)
  return out
}

function existsDir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function matchPattern(path: string, pattern: string): boolean {
  // Token-based conversion: '**/' → any dirs, '*' → one segment, '?' → one
  // char. Tokens avoid the naive replace chain destroying its own quantifiers
  // (the '?' rule used to eat the '?' in '(?:.*/)?' — found by live-direct-read).
  const regex = new RegExp('^' + pattern
    .replaceAll('**/', '\u0000/')
    .replaceAll('**', '\u0000')
    .replaceAll('*', '\u0001')
    .replaceAll('?', '\u0002')
    .replaceAll('\u0000/', '(?:[^/]*/)*')
    .replaceAll('\u0000', '.*')
    .replaceAll('\u0001', '[^/]*')
    .replaceAll('\u0002', '[^/]') + '$')
  return regex.test(path)
}
