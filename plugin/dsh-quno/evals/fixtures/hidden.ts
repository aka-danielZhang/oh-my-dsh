/**
 * Hidden fixture generator for Live E2E cases (design §4.2): every run draws
 * seeded, randomized facts (owner, deadline, file name, error code) that exist
 * ONLY inside the fixture files. The facts are handed to the case's ORACLE,
 * never to the prompt — the model can only learn them through tools.
 *
 * @module dsh-quno/evals/fixtures/hidden
 */

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Oracle-only facts drawn for one live attempt. */
export interface HiddenFacts {
  readonly file: string
  readonly owner: string
  readonly deadline: string
  readonly errorCode: string
  readonly briefCode: string
  /** Plausible wrong values the reply must NOT contain (grounding check). */
  readonly distractorOwners: readonly string[]
  readonly distractorDeadlines: readonly string[]
  readonly distractorErrorCodes: readonly string[]
}

/** Deterministic RNG so a seed reproduces exactly the same fixture set. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function pick<T>(random: () => number, pool: readonly T[], exclude: readonly T[] = []): T {
  const options = pool.filter(entry => !exclude.includes(entry))
  const chosen = options[Math.floor(random() * options.length)] ?? pool[0]!
  return chosen
}

const OWNERS = ['张伟', '李婧', '陈昊', '赵一凡', '周雨桐', '吴启明', '郑晚晴', '孙立诚'] as const
const DAY_OFFSETS = [3, 5, 7, 10, 12, 14, 17, 21] as const
const FILE_STEMS = ['交接备注', '周会纪要', '需求变更单', '验收清单', '部署手册'] as const
const ERROR_CODES = ['ERR-4821', 'ERR-5107', 'ERR-6290', 'ERR-7345', 'ERR-8062', 'ERR-9118'] as const
const BRIEF_CODES = ['BR-2026-118', 'BR-2026-233', 'BR-2026-407', 'BR-2026-519', 'BR-2026-662'] as const

/** Draw one hidden fact set from a seed (same seed → same facts). */
export function generateHiddenFacts(seed: number): HiddenFacts {
  const random = mulberry32(seed)
  const owner = pick(random, OWNERS)
  const deadline = String(pick(random, DAY_OFFSETS))
  const errorCode = pick(random, ERROR_CODES)
  const briefCode = pick(random, BRIEF_CODES)
  const stem = pick(random, FILE_STEMS)
  const file = `${stem}-${briefCode.slice(-3)}.md`
  return {
    file,
    owner,
    deadline,
    errorCode,
    briefCode,
    distractorOwners: OWNERS.filter(entry => entry !== owner).slice(0, 3),
    distractorDeadlines: DAY_OFFSETS.filter(entry => entry !== Number(deadline)).slice(0, 3).map(offset => String(offset)),
    distractorErrorCodes: ERROR_CODES.filter(entry => entry !== errorCode).slice(0, 3),
  }
}

/** The brief file body: the hidden facts plus neutral noise. */
export function renderBriefFile(facts: HiddenFacts): string {
  return [
    `# ${facts.briefCode} 交接备注`,
    '',
    `截止日期：2026-11-${facts.deadline}`,
    `负责人：${facts.owner}`,
    '',
    '背景：这份备注只用于链路验收，内容为合成数据。',
    '附注：涉及系统迁移的窗口安排以运维日历为准。',
  ].join('\n')
}

/** The incident log body for the auto-investigate case. */
export function renderIncidentLog(facts: HiddenFacts): string {
  return [
    `# 事故记录 ${facts.errorCode}`,
    '',
    `state: FAILED`,
    `pipeline: ${facts.briefCode}-pipeline`,
    `error_code: ${facts.errorCode}`,
    `failed_step: deploy`,
    '',
    '排查提示：日志只包含上述结构化字段；不要臆造其他原因。',
  ].join('\n')
}

/** Write the hidden fixture files into the case's fixture dir. */
export function writeHiddenFixtures(fixtureDir: string, facts: HiddenFacts, files: 'brief' | 'incident'): void {
  const content = files === 'brief' ? renderBriefFile(facts) : renderIncidentLog(facts)
  writeFileSync(join(fixtureDir, facts.file), content, 'utf8')
}
