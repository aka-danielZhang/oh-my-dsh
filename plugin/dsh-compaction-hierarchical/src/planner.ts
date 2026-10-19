/** Pure tool-balanced grouping and greedy token-budget planning. */

import type { Message } from '@deepseek-ai/dsh-llm'

/** A selected message unit cannot fit one auxiliary model call. */
export class OversizedCompactionUnitError extends Error {
  override name = 'OversizedCompactionUnitError'
}

/** Callback matching the shared token meter's message estimator. */
export type EstimateMessage = (message: Message) => number

/**
 * Sum estimated tokens for an ordered message list.
 * @param messages - model-visible messages to price.
 * @param estimate - shared message estimator.
 * @returns non-negative estimated tokens.
 */
export function estimateMessages(
  messages: readonly Message[],
  estimate: EstimateMessage,
): number {
  return messages.reduce((total, message) => total + estimated(message, estimate), 0)
}

/**
 * Group messages into units whose boundaries never split tool calls from results.
 * @param messages - messages in provider order.
 * @returns balanced, non-empty units in the same order.
 */
export function toolBalancedUnits(messages: readonly Message[]): Message[][] {
  const units: Message[][] = []
  const pending = new Set<string>()
  let current: Message[] = []

  for (const message of messages) {
    current.push(message)
    if (message.role === 'assistant') {
      for (const block of message.content) {
        if (block.type !== 'tool-call') continue
        if (pending.has(block.id)) {
          throw new Error(`hierarchical compaction: duplicate tool call id ${block.id}`)
        }
        pending.add(block.id)
      }
    } else if (message.role === 'tool' && !pending.delete(message.toolCallId)) {
      throw new Error(
        `hierarchical compaction: tool result ${message.toolCallId} has no call in the selected input`,
      )
    }
    if (pending.size === 0) {
      units.push(current)
      current = []
    }
  }

  if (pending.size > 0) {
    throw new Error(
      `hierarchical compaction: selected input ends with ${pending.size} unresolved tool call(s)`,
    )
  }
  return units
}

/**
 * Greedily pack tool-balanced units under one message-token budget.
 * @param messages - messages in provider order.
 * @param budgetTokens - tokens available after header and instruction reserves.
 * @param estimate - shared message estimator.
 * @returns non-empty chunks in the same order.
 */
export function planMessageChunks(
  messages: readonly Message[],
  budgetTokens: number,
  estimate: EstimateMessage,
): Message[][] {
  if (!Number.isSafeInteger(budgetTokens) || budgetTokens < 1) {
    throw new Error('hierarchical compaction: message budget must be a positive integer')
  }
  const chunks: Message[][] = []
  let chunk: Message[] = []
  let chunkTokens = 0

  for (const unit of toolBalancedUnits(messages)) {
    const unitTokens = estimateMessages(unit, estimate)
    if (unitTokens > budgetTokens) {
      throw new OversizedCompactionUnitError(
        `hierarchical compaction: one indivisible message/tool unit needs ~${unitTokens} tokens, `
        + `above the ${budgetTokens}-token message budget`,
      )
    }
    if (chunk.length > 0 && chunkTokens + unitTokens > budgetTokens) {
      chunks.push(chunk)
      chunk = []
      chunkTokens = 0
    }
    chunk.push(...unit)
    chunkTokens += unitTokens
  }
  if (chunk.length > 0) chunks.push(chunk)
  return chunks
}

/**
 * Bisect one provider-rejected chunk at a tool-balanced unit boundary.
 * The selected boundary minimizes estimated token imbalance, then unit-count
 * imbalance when zero-priced units tie. Returning null proves the chunk is one
 * indivisible unit and cannot make further progress.
 * @param messages - one failed chronological chunk.
 * @param estimate - shared message estimator.
 * @returns two non-empty balanced halves, or null for one indivisible unit.
 */
export function splitMessageChunk(
  messages: readonly Message[],
  estimate: EstimateMessage,
): [Message[], Message[]] | null {
  const units = toolBalancedUnits(messages)
  if (units.length < 2) return null
  const weights = units.map(unit => estimateMessages(unit, estimate))
  const total = weights.reduce((sum, value) => sum + value, 0)
  let left = weights[0] ?? 0
  let splitAt = 1
  let bestTokenImbalance = Math.abs(total - 2 * left)
  let bestUnitImbalance = Math.abs(units.length - 2)

  for (let index = 2; index < units.length; index += 1) {
    left += weights[index - 1] ?? 0
    const tokenImbalance = Math.abs(total - 2 * left)
    const unitImbalance = Math.abs(units.length - 2 * index)
    if (tokenImbalance < bestTokenImbalance
      || (tokenImbalance === bestTokenImbalance && unitImbalance < bestUnitImbalance)) {
      splitAt = index
      bestTokenImbalance = tokenImbalance
      bestUnitImbalance = unitImbalance
    }
  }
  return [units.slice(0, splitAt).flat(), units.slice(splitAt).flat()]
}

/** Validate one estimator result at its same-process API boundary. */
function estimated(message: Message, estimate: EstimateMessage): number {
  const tokens = estimate(message)
  if (!Number.isSafeInteger(tokens) || tokens < 0) {
    throw new Error('hierarchical compaction: message estimator returned an invalid token count')
  }
  return tokens
}
