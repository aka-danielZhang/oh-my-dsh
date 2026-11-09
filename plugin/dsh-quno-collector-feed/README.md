# dsh-quno-collector-feed

Quno 的**订阅源采集器**：按 Host 调度轮询一个 RSS 2.0 / Atom 地址，用 `ETag` / `If-Modified-Since` 条件请求只取变化，按条目标识（GUID / Atom id，回退 link 哈希）+ 内容修订去重，只把新增或变化的条目作为不可变事件提交。纯 Host 插件，实现 `quno.collector/v2`（Host 统一调度，`run` 为一次条件请求轮询），不调用模型。

## Install

```sh
dsh plugin --profile web add <repo>/plugin/dsh-quno-collector-feed
```

安装后 Quno 的「来源」页出现「消息源（RSS/Atom）」类型。

## Behavior

- 轮询模式，最小 60 秒、默认 300 秒；条件请求命中 `304` 时只更新游标与健康时间，不产生事件。
- 条目身份：`guid`/`id` 优先，缺失时用 link；修订为标题+链接+发布时间+摘要的内容哈希。同一批重试身份稳定，内容变化生成新事件。
- 只取最近 `maxItems` 条；源条目更多时显式报 gap（`changeCoverage: sampled`），不声称覆盖全史。
- 失败分类：401/403 → `auth-required`；429 → `rate-limited`（按 `Retry-After` 退避）；5xx → `unavailable`；其余 → `degraded`。健康快照含连续失败数、下次重试时间与条目滞后秒数。
- 不发送任何凭据；需要鉴权的源请用可公开访问的地址或后续版本。
- **首轮语义（`firstSync: current-window-events`）**：首次轮询会把当前页面里没见过的条目立即入库——不是「从现在起才可见」，安装前后可能一次补入若干条历史条目。

## Config

| 字段 | 默认 | 说明 |
|---|---|---|
| `url` | — | 必填，http(s) 订阅源地址 |
| `intervalSec` | `300` | 轮询间隔，最小 60 |
| `maxItems` | `50` | 单次最多条目（1–200） |
| `label` | 源标题 | 显示名；缺省用 feed 的 `<title>` |

## Development

```sh
cd plugin/dsh-quno-collector-feed
pnpm install && pnpm run typecheck && pnpm run test && pnpm run build
```

测试用本地 `node:http` 服务验证 304、429 与解析；类型来自 `../dsh-quno/src/{types,collectors}.ts`（type-only）。

## Design notes

- Quno 设计：`docs/quno-bot-design.md`（§6 Collector 契约）。
- 落地决策：`docs/notes/2026-10-23-quno-implementation.md`。
