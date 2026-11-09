/**
 * The credential-free protocol self-check (design §10 step 1): SSE → chunk
 * assembly and OpenAI history mapping keep provider tool-call ids paired with
 * tool results. `pnpm run eval:protocol` runs this before any live attempt.
 *
 * @module dsh-quno/evals/protocol
 */

import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SseAssembler, toOpenAiMessages } from './models/gateway.ts'
import { resolveModelPlan, sanitizeBaseUrl } from './plan.ts'
import { aggregateUsage, usageFromProvider } from './usage.ts'

export interface ProtocolCheck {
  readonly name: string
  readonly pass: boolean
  readonly detail?: string
}

const SSE_TOOL_CALL = [
  'data: {"choices":[{"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_provider_42","function":{"name":"read","arguments":""}}]}}]}',
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":\\"notes.md\\"}"}}]}}]}',
  'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":10,"completion_tokens":3}}',
  'data: [DONE]',
]

/** Run all protocol checks; returns them for rendering. */
export function runProtocolChecks(): readonly ProtocolCheck[] {
  const out: ProtocolCheck[] = []

  // 1. SSE assembly keeps the provider id across delta → block-end.
  try {
    const assembler = new SseAssembler()
    const chunks = SSE_TOOL_CALL.flatMap(line => assembler.push(line)).concat(assembler.finalize())
    const delta = chunks.find(chunk => chunk.type === 'tool-call-delta')
    const end = chunks.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call')
    const finish = chunks.find(chunk => chunk.type === 'finish')
    const ok = delta !== undefined && delta.type === 'tool-call-delta' && delta.id === ToolCallId('call_provider_42')
      && end !== undefined && end.type === 'block-end' && end.block.type === 'tool-call' && end.block.id === ToolCallId('call_provider_42')
      && end.block.name === 'read' && end.block.arguments === '{"path":"notes.md"}'
      && finish !== undefined && finish.type === 'finish' && finish.reason.kind === 'tool-calls'
    out.push({ name: 'sse-preserves-provider-tool-call-id', pass: ok })
  } catch (error) {
    out.push({ name: 'sse-preserves-provider-tool-call-id', pass: false, detail: (error as Error).message })
  }

  // 2. Replayed history maps assistant tool calls and tool results to the
  //    SAME id (the pairing providers validate).
  try {
    const assistant = {
      role: 'assistant',
      source: { kind: 'model' },
      content: [
        { type: 'text', text: '我来读取文件。' },
        { type: 'tool-call', id: ToolCallId('call_provider_42'), name: 'read', arguments: '{"path":"notes.md"}' },
      ],
    } as never
    const toolResult = {
      role: 'tool',
      source: { kind: 'tool', callId: ToolCallId('call_provider_42') },
      toolCallId: ToolCallId('call_provider_42'),
      content: [{ type: 'text', text: '截止日期：2026-11-14' }],
    } as never
    const user = {
      role: 'user',
      source: { kind: 'user' },
      content: [{ type: 'text', text: '帮我读 notes.md' }],
    } as never
    const mapped = toOpenAiMessages({ messages: [user, assistant, toolResult] } as never) as {
      role: string
      tool_calls?: { id: string }[]
      tool_call_id?: string
    }[]
    const assistantRow = mapped.find(row => row.role === 'assistant')
    const toolRow = mapped.find(row => row.role === 'tool')
    const callId = assistantRow?.tool_calls?.[0]?.id
    const ok = callId === 'call_provider_42' && toolRow?.tool_call_id === 'call_provider_42'
    out.push({ name: 'history-keeps-toolcallid-paired', pass: ok, ...(ok ? {} : { detail: `assistant=${String(callId)} tool=${String(toolRow?.tool_call_id)}` }) })
  } catch (error) {
    out.push({ name: 'history-keeps-toolcallid-paired', pass: false, detail: (error as Error).message })
  }

  // 3. A missing provider id falls back to a stable synthesized id.
  try {
    const assembler = new SseAssembler()
    const chunks = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"glob","arguments":"{}"}}]}}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
    ].flatMap(line => assembler.push(line)).concat(assembler.finalize())
    const end = chunks.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call')
    const ok = end !== undefined && end.type === 'block-end' && end.block.type === 'tool-call' && /^call_\d+$/.test(end.block.id)
    out.push({ name: 'synthesized-id-stable', pass: ok })
  } catch (error) {
    out.push({ name: 'synthesized-id-stable', pass: false, detail: (error as Error).message })
  }

  // 4. ModelPlan merge order: builtin → env → case → CLI (later wins).
  try {
    const env = { QUNO_EVAL_LIVE_MODEL: 'env-model' } as NodeJS.ProcessEnv
    const builtin = resolveModelPlan({ env })
    const withCase = resolveModelPlan({ env, caseRouter: 'case-model' })
    const withCli = resolveModelPlan({ env, caseRouter: 'case-model', router: 'cli-model' })
    const ok = builtin.router.model === 'env-model'
      && withCase.router.model === 'case-model' && withCase.worker.model === 'env-model'
      && withCli.router.model === 'cli-model'
    out.push({ name: 'model-plan-merge-order', pass: ok, ...(ok ? {} : { detail: JSON.stringify({ builtin: builtin.router.model, case: withCase.router.model, cli: withCli.router.model }) }) })
  } catch (error) {
    out.push({ name: 'model-plan-merge-order', pass: false, detail: (error as Error).message })
  }

  // 5. The plan carries a credential REFERENCE only — never a value.
  try {
    const plan = resolveModelPlan({ env: { QUNO_EVAL_LIVE_API_KEY: 'sk-secret-do-not-leak-123456' } as NodeJS.ProcessEnv })
    const serialized = JSON.stringify(plan)
    out.push({ name: 'model-plan-no-secret', pass: !serialized.includes('sk-secret-do-not-leak-123456') && plan.router.credentialRef === 'env:QUNO_EVAL_LIVE_API_KEY' })
  } catch (error) {
    out.push({ name: 'model-plan-no-secret', pass: false, detail: (error as Error).message })
  }

  // 6. baseUrl sanitization drops query credentials.
  try {
    const sanitized = sanitizeBaseUrl('https://api.example.com/v1?api_key=supersecret&x=1')
    out.push({ name: 'base-url-sanitized', pass: sanitized === 'https://api.example.com/v1' && !sanitized.includes('supersecret') })
  } catch (error) {
    out.push({ name: 'base-url-sanitized', pass: false, detail: (error as Error).message })
  }

  // 7. usageMissing: requests without provider usage are counted, never 0-filled.
  try {
    const usage = aggregateUsage([
      { role: 'router', sessionId: 's1', stage: 'eval.candidate', durationMs: 10, usage: usageFromProvider({ inputTokens: 100, outputTokens: 20 }), caseId: 'c', execution: { requested: { provider: 'p', model: 'm', baseUrl: '' } } },
      { role: 'worker', sessionId: 's2', stage: 'worker.execution', durationMs: 5, usage: null, caseId: 'c', execution: { requested: { provider: 'p', model: 'm', baseUrl: '' } } },
    ])
    const ok = usage.run.modelCalls === 2 && usage.run.inputTokens === 100 && usage.run.totalTokens === 120
      && usage.run.usageMissing === 1
    out.push({ name: 'usage-missing-accounted', pass: ok, ...(ok ? {} : { detail: JSON.stringify(usage.run) }) })
  } catch (error) {
    out.push({ name: 'usage-missing-accounted', pass: false, detail: (error as Error).message })
  }

  return out
}

/** Render the protocol check result as plain text. */
export function renderProtocolChecks(checks: readonly ProtocolCheck[]): string {
  const lines = ['# Live 协议自检（无网络、无凭据）', '']
  for (const check of checks) {
    lines.push(`- ${check.pass ? '✅' : '❌'} ${check.name}${check.detail === undefined ? '' : ` — ${check.detail}`}`)
  }
  lines.push('')
  lines.push(checks.every(check => check.pass) ? '协议检查全部通过，可以进入 Live 冒烟（eval:live -- --case live-direct-read）。' : '协议检查未通过：先修复，再进入 Live。')
  return lines.join('\n')
}
