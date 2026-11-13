/**
 * The structured CLI capability gone end to end: a real child process answers
 * a Worker's `quno_cli_call`, the fact flows into the Report and the
 * permanent conversation, and a refusal never starts a process.
 *
 * These are release-gate cases, not unit tests: the whole chain
 * (broker → provider → real process → tool result → report → relay) runs in
 * the real composition. The failure/relay case pins the P1 fix that a
 * terminal Exchange failure is delivered instead of silently completing.
 *
 * @module dsh-quno/evals/cases/cli
 */

import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { EvalCase } from '../case.ts'
import type { EvalRuntime } from '../runtime.ts'
import { writeFixtureFiles } from '../fixtures/fs.ts'
import { textTurn, toolTurn } from '../models/scripted.ts'
import {
  check,
  executorSessionFor,
  imMention,
  MAIN_SESSION,
  replyContainsFact,
  replyMustNotClaim,
  sessionEvents,
  toolCalls,
  toolResults,
} from './support.ts'
import type { CliCallRequest, CliCallOutcome, CliCapabilityProvider, CliOperationSpec } from '../../src/cli-broker.ts'
import type { SenseDefinition } from '../../src/types.ts'
import type { SenseFactory, SenseHandle } from '../../src/senses.ts'

const SENSE_TYPE = 'eval/cli-im'
const CAPABILITY = 'eval-cli'
const FACT = '今晚 18:00 评审'
const FAILING_KEYWORD = 'boom'

/** A real, tiny CLI: prints one JSON envelope and honours the yzj argv shape. */
const FAKE_CLI = String.raw`
import { appendFileSync } from 'node:fs'
const args = process.argv.slice(2)
const log = process.env.QUNO_EVAL_CLI_LOG
if (log !== undefined && log !== '') appendFileSync(log, JSON.stringify(args) + '\n')
const flag = (name) => { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1] }
const limit = Number(flag('--limit') ?? 5)
const keyword = flag('--keyword') ?? ''
if (keyword === '${FAILING_KEYWORD}') {
  process.stderr.write(JSON.stringify({ success: false, error: { subtype: 'authentication', message: '评测 CLI 未登录' } }))
  process.exit(3)
}
const items = [{ id: 'g1', name: '研发群', text: '${FACT}' }].slice(0, Math.max(1, limit))
process.stdout.write(JSON.stringify({ success: true, data: { list: items, more: false } }))
`

const OPERATIONS: Readonly<Record<string, CliOperationSpec>> = {
  'items.list': {
    access: 'read',
    summary: '读取一个会话窗口的最新消息',
    params: [
      { name: 'limit', kind: 'integer', min: 1, max: 20, description: '条数 1-20' },
      { name: 'keyword', kind: 'string', maxChars: 32, description: '关键词（评测中用于触发鉴权失败）' },
    ],
  },
}

interface CliRun {
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
  readonly failure: string | null
}

/** Spawn the fixture CLI as a real child process (no shell, argv array). */
function runFixtureCli(script: string, args: readonly string[], log: string, signal: AbortSignal, timeoutMs: number): Promise<CliRun> {
  return new Promise<CliRun>((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, QUNO_EVAL_CLI_LOG: log },
    })
    let stdout = ''
    let stderr = ''
    let failure: string | null = null
    const finish = (code: number | null): void => {
      cleanups.forEach(dispose => dispose())
      resolve({ code, stdout, stderr, failure })
    }
    const kill = (): void => {
      failure = 'timeout'
      child.kill('SIGKILL')
    }
    const timer = setTimeout(kill, timeoutMs)
    const onAbort = (): void => {
      failure = 'aborted'
      child.kill('SIGKILL')
    }
    const cleanups = [
      () => clearTimeout(timer),
      () => signal.removeEventListener('abort', onAbort),
    ]
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { stdout += chunk })
    child.stderr.on('data', (chunk: string) => { stderr += chunk })
    child.on('error', (error) => {
      failure = 'spawn-error'
      stderr += error.message
      finish(null)
    })
    child.on('close', code => finish(code))
  })
}

/** The provider under test: argv comes from here, never from the model. */
function fixtureProvider(script: string, log: string): CliCapabilityProvider {
  return {
    capability: CAPABILITY,
    title: '评测 CLI',
    senseType: SENSE_TYPE,
    operations: OPERATIONS,
    timeoutMs: 5_000,
    async execute(request: CliCallRequest): Promise<CliCallOutcome> {
      const args = [
        '--profile', String(request.target.config['profile'] ?? 'default'),
        'items', 'list',
        '--limit', String(request.params['limit'] ?? 5),
        ...(request.params['keyword'] === undefined ? [] : ['--keyword', String(request.params['keyword'])]),
      ]
      const run = await runFixtureCli(script, args, log, request.signal, request.timeoutMs)
      if (run.failure !== null) {
        return { ok: false, code: 'unavailable', message: `评测 CLI 无法执行：${run.failure}`, retryable: true }
      }
      if (run.code === 3) return { ok: false, code: 'auth-required', message: '评测 CLI 未登录' }
      if (run.code !== 0) return { ok: false, code: `exit-${String(run.code)}`, message: run.stderr.trim().slice(0, 200) }
      try {
        const envelope = JSON.parse(run.stdout) as { success?: boolean; data?: { list?: unknown } }
        return { ok: true, data: { list: envelope.data?.list ?? [] } }
      } catch {
        return { ok: false, code: 'bad-envelope', message: 'CLI 输出不是 JSON' }
      }
    },
  }
}

function noopFactory(): SenseFactory {
  return {
    validateConfig: () => ({ ok: true, value: {} }),
    start(): SenseHandle {
      return { stop() {} }
    },
  }
}

function cliSenseDefinition(): SenseDefinition {
  return {
    type: SENSE_TYPE,
    contractVersion: 'quno.sense/v1',
    implementationVersion: '0.0.1',
    displayName: '评测 CLI 来源',
    description: 'eval-only Sense carrying the configured CLI target',
    eventTypes: [],
    permissions: { reads: [] },
    runtime: { modes: ['poll'], defaultIntervalSec: 300, minIntervalSec: 60, concurrency: 1, timeoutMs: 5_000 },
    reliability: {
      checkpoint: 'none',
      replay: { kind: 'none' },
      changeCoverage: 'sampled',
      gapDetection: 'none',
      readOriginal: false,
    },
  }
}

interface CliFixture {
  readonly log: string
  readonly targetId: string
}

/** Mount the eval Sense, configure one target and register the provider. */
async function installCliFixture(rt: EvalRuntime): Promise<CliFixture> {
  const script = join(rt.fixtureDir, 'fake-cli.mjs')
  const log = join(rt.fixtureDir, 'cli-calls.log')
  writeFixtureFiles(rt.fixtureDir, [{ path: 'fake-cli.mjs', content: FAKE_CLI }])
  const registered = rt.host.senses.register(cliSenseDefinition(), noopFactory())
  void registered
  const created = rt.host.senses.createInstance({
    type: SENSE_TYPE,
    label: '评测云之家账号',
    config: { profile: 'eval-work' },
    desiredState: 'enabled',
  })
  if (!created.ok) throw new Error(`eval cli sense: ${created.error.message}`)
  // Pausing the Sense stops its polling, not its configured account: the
  // explicit read capability must keep working (design §5.4 / 2026-11-13).
  await rt.host.senses.pause(created.instance.id)
  rt.host.cli.register(fixtureProvider(script, log))
  return { log, targetId: created.instance.id }
}

function cliCallCount(log: string): number {
  try {
    return readFileSync(log, 'utf8').split('\n').filter(line => line.trim() !== '').length
  } catch {
    return 0
  }
}

function lastTicket(rt: EvalRuntime): ReturnType<EvalRuntime['host']['repo']['listTickets']>[number] | undefined {
  return rt.host.repo.listTickets(rt.host.qunoId, { limit: 5 }).at(-1)
}

export const cliCases: readonly EvalCase[] = [
  {
    id: 'cli-capability-read',
    title: 'Worker 经结构化 CLI 读取真实进程，结果回流主对话',
    priority: 'p0',
    requirement: 'quno_cli_call → provider → 真实子进程 → 同一回合拿到结果 → report ready → 主对话只汇报一次',
    tags: ['cli', 'worker', 'release-gate'],
    model: { router: 'scripted', worker: 'scripted' },
    setup: async (rt) => {
      await rt.host.updateConfig({ patch: { acceptMode: 'auto' } })
      await installCliFixture(rt)
    },
    scripts: {
      router: [
        toolTurn('quno_eval', {}, 'cr-eval-1'),
        toolTurn('quno_eval_decide', { kind: 'accept', title: '查最近消息', goal: '用结构化 CLI 读取最近消息并汇报。' }, 'cr-decide-1'),
        textTurn('已受理。'),
        textTurn(`研发群最近一条：${FACT}。`),
      ],
      worker: [],
    },
    steps: [
      { kind: 'script', role: 'worker', build: () => toolTurn('quno_read', {}, 'cr-worker-read-1') },
      {
        kind: 'script',
        role: 'worker',
        build: () => toolTurn('quno_cli_call', { capability: CAPABILITY, operation: 'items.list', params: { limit: 2 } }, 'cr-worker-call-1'),
      },
      {
        kind: 'script',
        role: 'worker',
        build: () => toolTurn('quno_worker_report', { state: 'ready', summary: `研发群最近一条：${FACT}` }, 'cr-worker-ready-1'),
      },
      { kind: 'script', role: 'worker', build: () => textTurn('已提交。') },
      { kind: 'ingest', envelopes: [imMention('cr-trigger-1', '@Quno 查一下研发群最近消息', Date.parse('2026-11-06T09:45:00Z'))] },
    ],
    checks: (rt) => {
      const ticket = lastTicket(rt)
      const sessionId = ticket === undefined ? '' : executorSessionFor(ticket.id)
      const calls = sessionId === '' ? [] : toolCalls(rt, sessionId)
      const results = sessionId === '' ? [] : toolResults(rt, sessionId)
      const relays = sessionEvents(rt, MAIN_SESSION)
        .filter(event => event.type === 'user/message')
        .filter(event => (event.data as { source?: { kind?: string } }).source?.kind === 'quno-report')
      const report = ticket === undefined ? undefined : rt.host.repo.listAssignmentsByTicket(ticket.id).at(-1)?.report
      const targets = rt.host.cli.describe().flatMap(view => view.targets)
      return {
        chain: [
          check('ticket.mandate', 'granted-capability', ticket?.mandate.cli?.capabilities.includes(CAPABILITY) === true, CAPABILITY, ticket?.mandate.cli?.capabilities ?? []),
          check('ticket.mandate', 'paused-target-still-listed', targets.length === 1, 1, targets.length),
          check('worker.execution', 'cli-called', calls.some(call => call.name === 'quno_cli_call'), ['quno_cli_call'], calls.map(call => call.name)),
          check('worker.execution', 'real-process-answer', results.some(text => text.includes(FACT)), [FACT], results.slice(-1)),
          check('worker.report', 'report-has-fact', report?.summary.includes(FACT) === true, FACT, report?.summary ?? ''),
          check('router.relay', 'relayed-once', relays.length === 1, 1, relays.length),
        ],
        semantics: [replyContainsFact('cli-fact', FACT, rt)],
      }
    },
    budget: { maxDurationMs: 120_000, maxModelCalls: 10 },
  },
  {
    id: 'cli-capability-refuse',
    title: '未声明的参数不启动进程，拒绝可指导后仍能完成读取',
    priority: 'p0',
    requirement: 'payload 带 profile → 参数校验拒绝且零进程；改用合法参数 → 成功 → report ready',
    tags: ['cli', 'worker', 'release-gate', 'security'],
    model: { router: 'scripted', worker: 'scripted' },
    setup: async (rt) => {
      await rt.host.updateConfig({ patch: { acceptMode: 'auto' } })
      await installCliFixture(rt)
    },
    scripts: {
      router: [
        toolTurn('quno_eval', {}, 'cf-eval-1'),
        toolTurn('quno_eval_decide', { kind: 'accept', title: '查最近消息', goal: '用结构化 CLI 读取最近消息并汇报。' }, 'cf-decide-1'),
        textTurn('已受理。'),
        textTurn(`研发群最近一条：${FACT}。`),
      ],
      worker: [],
    },
    steps: [
      {
        kind: 'script',
        role: 'worker',
        build: () => toolTurn('quno_cli_call', { capability: CAPABILITY, operation: 'items.list', params: { profile: 'attacker' } }, 'cf-worker-bad-1'),
      },
      {
        kind: 'script',
        role: 'worker',
        build: () => toolTurn('quno_cli_call', { capability: CAPABILITY, operation: 'items.list', params: { limit: 2 } }, 'cf-worker-good-1'),
      },
      {
        kind: 'script',
        role: 'worker',
        build: () => toolTurn('quno_worker_report', { state: 'ready', summary: `研发群最近一条：${FACT}` }, 'cf-worker-ready-1'),
      },
      { kind: 'script', role: 'worker', build: () => textTurn('已提交。') },
      { kind: 'ingest', envelopes: [imMention('cf-trigger-1', '@Quno 查一下研发群最近消息', Date.parse('2026-11-06T09:45:00Z'))] },
    ],
    checks: (rt) => {
      const ticket = lastTicket(rt)
      const sessionId = ticket === undefined ? '' : executorSessionFor(ticket.id)
      const results = sessionId === '' ? [] : toolResults(rt, sessionId)
      // The fixture appends one line per REAL process; the refused call must
      // not appear here.
      const log = join(rt.fixtureDir, 'cli-calls.log')
      const spawned = cliCallCount(log)
      return {
        chain: [
          check('worker.execution', 'refusal-explains-parameter', results.some(text => text.includes('不接受参数 profile')), '不接受参数 profile', results.slice(0, 1)),
          check('worker.execution', 'refused-call-spawned-nothing', spawned === 1, 1, spawned),
          check('worker.execution', 'corrected-call-succeeded', results.some(text => text.includes(FACT)), [FACT], results.slice(-1)),
        ],
        semantics: [
          replyContainsFact('cli-refuse-recovered', FACT, rt),
          replyMustNotClaim('cli-refuse-no-fake-success', '查询成功', rt),
        ],
      }
    },
    budget: { maxDurationMs: 120_000, maxModelCalls: 10 },
  },
  {
    id: 'cli-capability-failure',
    title: 'CLI 失败必须如实回流，不得声称查询成功',
    priority: 'p0',
    requirement: '鉴权失败的 CLI → 工具错误带 code → report blocked → 主对话只 relay 一次并说明失败',
    tags: ['cli', 'relay', 'release-gate'],
    model: { router: 'scripted', worker: 'scripted' },
    setup: async (rt) => {
      await rt.host.updateConfig({ patch: { acceptMode: 'auto' } })
      await installCliFixture(rt)
    },
    scripts: {
      router: [
        toolTurn('quno_eval', {}, 'ck-eval-1'),
        toolTurn('quno_eval_decide', { kind: 'accept', title: '查最近消息', goal: '用结构化 CLI 读取最近消息并汇报。' }, 'ck-decide-1'),
        textTurn('已受理。'),
        textTurn('读取失败：评测 CLI 未登录，暂时查不到消息。'),
      ],
      worker: [],
    },
    steps: [
      {
        kind: 'script',
        role: 'worker',
        build: () => toolTurn('quno_cli_call', { capability: CAPABILITY, operation: 'items.list', params: { keyword: FAILING_KEYWORD } }, 'ck-worker-call-1'),
      },
      {
        kind: 'script',
        role: 'worker',
        build: () => toolTurn('quno_worker_report', {
          state: 'blocked',
          summary: '评测 CLI 未登录，无法读取消息',
          question: { question: '请先在宿主机完成 yzj-cli 登录，然后让我重试这条查询。' },
        }, 'ck-worker-report-1'),
      },
      { kind: 'script', role: 'worker', build: () => textTurn('已提交。') },
      { kind: 'ingest', envelopes: [imMention('ck-trigger-1', '@Quno 查一下研发群最近消息', Date.parse('2026-11-06T09:45:00Z'))] },
    ],
    checks: (rt) => {
      const ticket = lastTicket(rt)
      const sessionId = ticket === undefined ? '' : executorSessionFor(ticket.id)
      const results = sessionId === '' ? [] : toolResults(rt, sessionId)
      const report = ticket === undefined ? undefined : rt.host.repo.listAssignmentsByTicket(ticket.id).at(-1)?.report
      const relays = sessionEvents(rt, MAIN_SESSION)
        .filter(event => event.type === 'user/message')
        .filter(event => (event.data as { source?: { kind?: string } }).source?.kind === 'quno-report')
      return {
        chain: [
          check('worker.execution', 'failure-is-visible', results.some(text => text.includes('未登录')), '未登录', results.slice(0, 1)),
          check('worker.report', 'report-blocked', report?.state === 'blocked', 'blocked', report?.state ?? 'none'),
          check('router.relay', 'relayed-once', relays.length === 1, 1, relays.length),
        ],
        semantics: [
          replyMustNotClaim('cli-failure-no-fake-success', '查询成功', rt),
          replyContainsFact('cli-failure-reported', '未登录', rt),
        ],
      }
    },
    budget: { maxDurationMs: 120_000, maxModelCalls: 10 },
  },
  {
    id: 'exchange-failure-relay',
    title: 'Exchange 终态失败必须回流主对话，不静默完成',
    priority: 'p0',
    requirement: 'Router 发起 exchange → organ 失败 → 失败原因作为一次 relay 进入主对话（只一次），且不得声称成功',
    tags: ['exchange', 'relay', 'release-gate'],
    model: { router: 'scripted', worker: 'scripted' },
    scripts: { router: [], worker: [] },
    steps: [
      // The tool turn must be queued before the human message triggers the
      // first model call, so it is pushed as a script step rather than
      // declared statically (it needs the organ instance id).
      {
        kind: 'script',
        role: 'router',
        build: (_rt, drv) => toolTurn('quno_exchange', { responder: `organ:${String(drv.organInstanceId)}`, kind: 'command', payload: { op: 'x' } }, 'ef-exchange-1'),
      },
      { kind: 'script', role: 'router', build: () => textTurn('已发起读取，结果回来我再告诉你。') },
      { kind: 'human', text: '帮我读一下那个来源' },
      { kind: 'script', role: 'router', build: () => textTurn('读取失败：这个 organ 暂时不可用，稍后可以再试。') },
    ],
    checks: (rt) => {
      const relays = sessionEvents(rt, MAIN_SESSION)
        .filter(event => event.type === 'user/message')
        .filter(event => (event.data as { source?: { kind?: string } }).source?.kind === 'quno-report')
      const relayText = relays
        .map(event => (event.data as { content?: readonly { type?: string; text?: string }[] }).content ?? [])
        .flatMap(blocks => blocks.filter(block => block.type === 'text').map(block => block.text ?? ''))
        .join('\n')
      const exchanges = rt.host.repo.listExchanges(rt.host.qunoId, { limit: 5 })
      const exchange = exchanges.at(-1)
      return {
        chain: [
          check('router.relay', 'exchange-failed', exchange?.status === 'failed', 'failed', exchange?.status ?? 'none'),
          check('router.relay', 'failure-relayed-once', relays.length === 1, 1, relays.length),
          check('router.relay', 'failure-text-carries-reason', relayText.includes('异步读取失败'), '【Quno 异步读取失败】', relayText.slice(0, 300)),
        ],
        semantics: [replyMustNotClaim('no-fake-success', '查询成功', rt)],
      }
    },
    budget: { maxDurationMs: 60_000, maxModelCalls: 6 },
  },
]
