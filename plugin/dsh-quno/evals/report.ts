/**
 * Evidence bundle writers: report.json + report.md per run (design §8.3).
 *
 * The report shows only what the design allows: case verdicts, the first
 * failed stage, expected vs actual, evidence paths, blocked-vs-failed
 * distinction and (when present) the diff against the previous run.
 *
 * @module dsh-quno/evals/report
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CaseChecks, BlockedCase, EvalCase } from './case.ts'
import type { TraceRecorder, StageName } from './trace.ts'
import type { ModelPlan } from './plan.ts'
import type { UsageSummary } from './usage.ts'

/** The UsageLedger view attached to every report (design §5). */
export interface UsageAggregates {
  readonly run: UsageSummary
  readonly byRole: Record<string, UsageSummary>
  readonly byModel: Record<string, UsageSummary>
  readonly bySession: Record<string, UsageSummary>
  readonly byStage: Record<string, UsageSummary>
  readonly byCase: Record<string, UsageSummary>
}

/** Verdict of one case attempt. */
export type CaseStatus = 'pass' | 'fail' | 'blocked' | 'error'

export interface CaseReport {
  readonly id: string
  readonly title: string
  readonly priority: 'p0' | 'p1'
  readonly runnable: boolean
  readonly status: CaseStatus
  readonly attempts: number
  readonly firstFailedStage: StageName | null
  readonly blockedReason?: string
  readonly chainFailed: readonly { readonly stage: StageName; readonly name: string; readonly expected?: unknown; readonly actual?: unknown }[]
  readonly semanticsFailed: readonly { readonly id: string; readonly kind: string; readonly description: string }[]
  readonly budget: { readonly durationMs: number; readonly modelCalls: number; readonly withinBudget: boolean }
  readonly error?: string
  readonly evidence: string
  readonly statusByStage: Record<string, string>
  /** Live E2E failure classification (design §7.3); absent for scripted runs. */
  readonly classification?: { readonly cls: string; readonly detail: string }
}

export interface RunReport {
  readonly runId: string
  readonly startedAt: number
  readonly finishedAt: number
  readonly modelPlan: ModelPlan
  readonly keep: string
  readonly cases: readonly CaseReport[]
  readonly globals: readonly { readonly name: string; readonly pass: boolean; readonly detail?: string }[]
  /** UsageLedger aggregates over the run's model requests (design §5). */
  readonly usage: UsageAggregates
  readonly verdict: 'pass' | 'fail'
  readonly previous?: { readonly runId: string; readonly newFailures: readonly string[]; readonly fixed: readonly string[]; readonly stillFailing: readonly string[] }
}

/** Finalize one case's report entry. */
export function caseReport(input: {
  readonly entry: EvalCase | BlockedCase
  readonly status: CaseStatus
  readonly attempts: number
  readonly trace: TraceRecorder
  readonly checks?: CaseChecks
  readonly durationMs: number
  readonly modelCalls: number
  readonly error?: string
  readonly firstFailedStage: StageName | null
  readonly classification?: { readonly cls: string; readonly detail: string }
}): CaseReport {
  const evidence = input.trace.paths().trace
  const statusByStage: Record<string, string> = {}
  for (const event of input.trace.all()) {
    if (event.status === 'started') continue
    statusByStage[event.stage] = event.status
  }
  const chainFailed = (input.checks?.chain ?? [])
    .filter(check => !check.pass)
    .map(check => ({
      stage: check.stage,
      name: check.name,
      ...(check.expected === undefined ? {} : { expected: check.expected }),
      ...(check.actual === undefined ? {} : { actual: check.actual }),
    }))
  const semanticsFailed = (input.checks?.semantics ?? [])
    .filter(item => !item.pass)
    .map(item => ({ id: item.id, kind: item.kind, description: item.description }))
  const runnable = (input.entry as EvalCase).steps !== undefined
  return {
    id: input.entry.id,
    title: input.entry.title,
    priority: input.entry.priority,
    runnable,
    status: input.status,
    attempts: input.attempts,
    firstFailedStage: input.firstFailedStage,
    ...(runnable ? {} : { blockedReason: (input.entry as BlockedCase).reason }),
    chainFailed,
    semanticsFailed,
    budget: {
      durationMs: Math.round(input.durationMs),
      modelCalls: input.modelCalls,
      withinBudget: (input.entry as EvalCase).budget === undefined
        || (input.durationMs <= ((input.entry as EvalCase).budget?.maxDurationMs ?? Number.POSITIVE_INFINITY)
          && input.modelCalls <= ((input.entry as EvalCase).budget?.maxModelCalls ?? Number.POSITIVE_INFINITY)),
    },
    ...(input.error === undefined ? {} : { error: input.error }),
    ...(input.classification === undefined ? {} : { classification: input.classification }),
    evidence,
    statusByStage,
  }
}

/** Serialize report.json and render report.md. */
export function writeReports(runDir: string, report: RunReport, previousDir: string | null): void {
  const withDiff = previousDir !== null ? attachDiff(report, previousDir) : report
  writeFileSync(join(runDir, 'report.json'), JSON.stringify(withDiff, null, 2) + '\n', 'utf8')
  writeFileSync(join(runDir, 'report.md'), renderMarkdown(withDiff), 'utf8')
}

function attachDiff(report: RunReport, previousDir: string): RunReport {
  try {
    const previous = JSON.parse(readFileSync(join(previousDir, 'report.json'), 'utf8')) as RunReport
    const prevFailed = new Set(previous.cases.filter(entry => entry.status !== 'pass').map(entry => entry.id))
    const nowFailed = new Set(report.cases.filter(entry => entry.status !== 'pass').map(entry => entry.id))
    return {
      ...report,
      previous: {
        runId: previous.runId,
        newFailures: [...nowFailed].filter(id => !prevFailed.has(id)),
        fixed: [...prevFailed].filter(id => !nowFailed.has(id)),
        stillFailing: [...prevFailed].filter(id => nowFailed.has(id)),
      },
    }
  } catch {
    return report
  }
}

function renderMarkdown(report: RunReport): string {
  const lines: string[] = []
  lines.push(`# Quno 链路评测 ${report.runId}`)
  lines.push('')
  const plan = report.modelPlan
  lines.push(`- 结论：**${report.verdict === 'pass' ? '通过' : '未通过'}**（router=${plan.router.model} @ ${plan.router.baseUrl} / worker=${plan.worker.model} @ ${plan.worker.baseUrl}；凭据=${plan.router.credentialRef}；keep=${report.keep}）`)
  lines.push('')
  lines.push('| Case | 优先级 | 结果 | 首个失败节点 | 预算 | 证据 |')
  lines.push('|---|---|---|---|---|---|')
  for (const entry of report.cases) {
    const firstFail = entry.chainFailed[0]
    const firstSem = entry.semanticsFailed[0]
    const detail = !entry.runnable
      ? `blocked：${entry.blockedReason ?? ''}`
      : entry.status === 'pass'
        ? 'pass'
        : entry.firstFailedStage ?? entry.error?.slice(0, 60) ?? entry.status
    const sub = entry.status !== 'pass' && entry.runnable
      ? (firstFail !== undefined ? `${firstFail.stage}/${firstFail.name}` : firstSem !== undefined ? firstSem.id : '')
      : ''
    lines.push(`| ${entry.id} | ${entry.priority} | ${entry.status} | ${detail}${sub === '' ? '' : `（${sub}）`} | ${entry.budget.withinBudget ? 'ok' : '超限'} | \`${entry.evidence}\` |`)
  }
  const firstFailure = report.cases.find(entry => entry.status === 'fail' || entry.status === 'error')
  if (firstFailure !== undefined) {
    lines.push('')
    lines.push(`## 首个失败：${firstFailure.id}`)
    if (firstFailure.classification !== undefined) {
      lines.push(`- 失败分类：**${firstFailure.classification.cls}**（${firstFailure.classification.detail}）`)
    }
    if (firstFailure.firstFailedStage !== null) lines.push(`- 阶段：\`${firstFailure.firstFailedStage}\``)
    if (firstFailure.error !== undefined) lines.push(`- 错误：${firstFailure.error}`)
    for (const check of firstFailure.chainFailed) {
      lines.push(`- 结构断言失败：${check.stage} / ${check.name}`)
      if (check.expected !== undefined) lines.push(`  - expected: \`${JSON.stringify(check.expected)}\``)
      if (check.actual !== undefined) lines.push(`  - actual: \`${JSON.stringify(check.actual)}\``)
    }
    for (const item of firstFailure.semanticsFailed) {
      lines.push(`- 语义必须项失败：${item.id}（${item.kind}）— ${item.description}`)
    }
    lines.push(`- 证据目录：\`${firstFailure.evidence}\`（trace.jsonl / model-requests.jsonl）`)
  }
  const globals = report.globals.filter(entry => !entry.pass)
  if (globals.length > 0) {
    lines.push('')
    lines.push('## 全局硬断言失败')
    for (const entry of globals) lines.push(`- ${entry.name}${entry.detail === undefined ? '' : `：${entry.detail}`}`)
  }
  lines.push(...renderUsage(report.usage))
  if (report.previous !== undefined) {
    lines.push('')
    lines.push(`## 与上一 run（${report.previous.runId}）对比`)
    lines.push(`- 新增失败：${report.previous.newFailures.length === 0 ? '无' : report.previous.newFailures.join('、')}`)
    lines.push(`- 已修复：${report.previous.fixed.length === 0 ? '无' : report.previous.fixed.join('、')}`)
    lines.push(`- 仍失败：${report.previous.stillFailing.length === 0 ? '无' : report.previous.stillFailing.join('、')}`)
  }
  lines.push('')
  return lines.join('\n')
}

/** Deterministic usage section (design §5): run / role / model / stage / case. */
function renderUsage(usage: UsageAggregates | undefined): string[] {
  if (usage === undefined) return []
  const lines: string[] = []
  lines.push('')
  lines.push('## Token 用量（UsageLedger，provider 原值）')
  lines.push('')
  const row = (label: string, s: UsageSummary): string => {
    const cache = s.cachedInputTokens === undefined ? '' : `，cache 读 ${String(s.cachedInputTokens)}`
    return `| ${label} | ${String(s.modelCalls)} | ${String(s.inputTokens)} | ${String(s.outputTokens)} | ${String(s.totalTokens)}${cache} | ${String(s.usageMissing)} | ${String(s.durationMs)} |`
  }
  lines.push('| 维度 | 调用 | 输入 | 输出 | 合计 | usage 缺失 | 耗时 ms |')
  lines.push('|---|---|---|---|---|---|---|')
  lines.push(row('**整次 Run**', usage.run))
  for (const [role, summary] of Object.entries(usage.byRole)) lines.push(row(`角色 ${role}`, summary))
  for (const [model, summary] of Object.entries(usage.byModel)) lines.push(row(`模型 ${model}`, summary))
  for (const [stage, summary] of Object.entries(usage.byStage)) lines.push(row(`阶段 ${stage}`, summary))
  for (const [caseId, summary] of Object.entries(usage.byCase)) lines.push(row(`Case ${caseId}`, summary))
  if (usage.run.usageMissing > 0) {
    lines.push('')
    lines.push(`> ⚠️ ${String(usage.run.usageMissing)} 个请求 provider 未返回 usage——这些请求的消耗**未知**，未计入 token 合计，也未按 0 处理。`)
  }
  return lines
}
