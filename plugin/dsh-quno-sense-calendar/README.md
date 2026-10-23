# dsh-quno-sense-calendar

Quno 的**日历 Sense**：读取本地 iCalendar（`.ics`）目录或单个文件，按 `UID` + 修订号做快照差分，把新增/改期作为不可变事件提交，把消失/取消作为显式撤回提交。纯 Host 插件，实现 `quno.sense/v1`：没有模型调用、没有对话副作用，只通过 Quno 的 ingest 写事件。

## Install

```sh
dsh plugin --profile web add <repo>/plugin/dsh-quno-sense-calendar
```

安装后 Quno 的「来源」页出现「日历（本地 .ics）」类型；`dsh-quno` 与本插件都必须启用。

## Behavior

- 轮询模式，最小 30 秒、默认 60 秒；停止/重配由 Quno 生命周期统一管理，`stop()` 幂等。
- 事件标识：`UID`；修订：`SEQUENCE:LAST-MODIFIED/DTSTAMP:内容哈希`。修订变化即新事件，旧事件保留。
- 删除/取消：提交 `operation: 'retract'` 的撤回事件（含上一修订），不静默删除历史。
- 时间：带 `Z` 按 UTC，带 `TZID` 按该时区，浮动时间按配置的 `timeZone` 解释；只保留「昨天起 24h」到 `lookaheadDays` 窗口内的事件。
- 缺口：文件数超过 `maxFiles` 或单文件读取失败会在批次里显式报 gap，健康态降为 `degraded`，不假装完整。
- 不支持 `RRULE` 展开（v1 的诚实限制），重复事件按首个 `DTSTART` 记录。

## Config

| 字段 | 默认 | 说明 |
|---|---|---|
| `directory` | — | `.ics` 目录；与 `file` 二选一 |
| `file` | — | 单个 `.ics` 文件 |
| `intervalSec` | `60` | 轮询间隔，最小 30 |
| `maxFiles` | `50` | 单次最多文件数（1–500） |
| `timeZone` | `Asia/Shanghai` | 浮动时间所属时区 |
| `lookaheadDays` | `30` | 向后看多少天 |

## Development

```sh
cd plugin/dsh-quno-sense-calendar
pnpm install && pnpm run typecheck && pnpm run test && pnpm run build
```

类型来自 `../dsh-quno/src/{types,senses}.ts`（type-only，不打包 Host 实现）。生产构建只产出 `lib/index.js`。

## Design notes

- Quno 设计：`docs/quno-bot-design.md`（§6 Sense 契约、§9 感知矩阵）。
- 落地决策：`docs/notes/2026-10-23-quno-implementation.md`。
