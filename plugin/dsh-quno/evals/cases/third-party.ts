/**
 * Real third-party source cases that need an explicit live-source opt-in.
 * They remain blocked until the corresponding production capability exists;
 * synthetic collectors must never make these cases pass.
 *
 * @module dsh-quno/evals/cases/third-party
 */

import type { BlockedCase } from '../case.ts'

export const thirdPartyCases: readonly BlockedCase[] = [
  {
    id: 'third-party-cli-live-read',
    title: '真实 yzj-cli 只读查询经采集器返回并回流',
    priority: 'p1',
    reason: 'F1–F3 已落地（query.handleRequest 白名单 + 发现面 + 门控收紧）；剩余激活前置：生产 profile 存在真实云之家实例，且 live-source smoke 显式选择只读账号与读取范围——合成采集器不得代替真实 CLI 证据',
  },
]
