# dsh-thread

Out-of-tree DeepSeek Harness plugin for explicit cross-session Thread handoffs.

The bundle installs the Host gateway, the globally-injected `thread_handoff` Tool, and the browser surface. One master switch lives in **Settings → General → Thread** (settings namespace `dsh-thread`, default on):

- **On**: every Session — any Agent preset — gets the `thread_handoff` Tool and its prompt guidance; the Session header shows the Thread utility and the capsule panel; the sidebar gains a **Thread 分组** list view (see below).
- **Off**: the Tool unregisters live, the header utility and capsule hide, the sidebar view withdraws from the view-options menu, and `authorize` answers `thread-disabled`. Historical Handoff cards keep their summary but lose the action.

No dedicated Agent preset is involved anymore: the earlier `standard-thread` preset is retired, and a confirmed continuation Session inherits the **source Session's own preset** (falling back to the deployment default). The Host derives and stamps it at authorization; the Client never names a preset.

`thread_handoff` only prepares an inert, bounded durable Draft and concludes the current turn. It never creates or wakes a Session. Direct Client confirmation owns the existing `session.create`/`session.rename` path; Host activation is added through the package Remote rather than by the Tool.

## The handoff saga: orthogonal checkpoints, not one state machine

From 0.3.0 the durable Link no longer carries a single overloaded `state`. Four independently recoverable groups describe the cross-domain saga:

- **target** — `reserved → creating → published`, plus `diverged`/`abandoned`. Identity is a fingerprint pinned at first reconciliation (`createdAt ≥ authorization`, `agentPreset`, workspace/cwd) and exact-matched afterwards. The deterministic target Session id makes `session.create` an idempotent adopt-or-create, so a crash between create and any later step never duplicates a Session.
- **title** — `pending → accepted | failed | unknown`. `requested` is user intent (audit/display only); `accepted` and `eventSeq` come exclusively from the successful `session.rename` response (the upstream Session Title service owns whitespace/control-character/byte-cap normalization — Thread never copies those rules) or from adopting the target log's current `session/title`. The Host verifies a client-reported `eventSeq` really names that `session/title` event. A failed or unknown title never blocks activation.
- **delivery** — `prepared → submitting → flushed | uncertain`. The message ids are persisted durably BEFORE the first inbox mutation, so every crash window is decidable by id presence in the target log: both present → commit; missing ones → re-deliver with fresh ids under a new attempt. An `uncertain` flush requires an explicit user-confirmed redelivery that self-detects landed messages and only re-sends what is missing.
- **relation** — `pending | active | abandoned`. It becomes `active` only after both messages are flushed durable.

Semantic purity is about model-visible semantics only: any number of `session/title` events is always allowed (display metadata never authenticates a target), while foreign `user/message`, turns, tools, commands, or inbox mutations mark the target `diverged` — and a diverged target is never injected again.

The confirmation card renders only real, executable recovery actions derived from the persisted checkpoints — 继续创建 / 重新检查 / 启动交接 / 打开已创建会话 / 克隆到新会话 / 重新投递 / 取消授权 — never a generic "retry" that the Host would reject. CAS-style staleness is handled by re-reading the durable Link (the user sees 「状态已更新」), and `cas-failed` is never a user-facing outcome. Legacy Links are migrated in place at the parse boundary and rewritten once at boot; the incident shape (`failed` + title-only pristine offense) becomes a published target awaiting re-activation, while genuinely diverged targets keep their ordinary Session and offer 克隆到新会话 with a fresh Draft/Link/target identity.

The Session header's right-aligned Thread utility toggles a persistent large capsule at the conversation body's top-right corner. It shows the current Thread identity, every connected Session, click-to-navigate rows, and explicit Handoff artifacts projected for the current Session. The capsule uses the shipped Settings surface tokens and closes only when the user clicks the Thread utility again; it never occupies or controls the shipped Tool `details` column. The utility and the capsule are gated on a started Session: a blank (empty-log) Session renders neither, so a fresh chat never sees an empty Thread surface.

Inside the capsule, the Session list shows at most 8 rows per page and the current Session's artifact list at most 5 cards per page; both overflow into a compact `‹ page / pages ›` pager. The Session pager auto-follows navigation so the current row stays on the visible page; the artifact pager restarts at page one whenever the viewed Session changes. A Session that belongs to no Thread gets a centered empty state (icon, title, one-line guidance) instead of a bare corner paragraph.

**Sidebar grouping**: while the switch is on, the plugin registers a `Thread 分组` entry into the fork's `sidebar.workspaces.sessionListView` view ring. The sidebar's view-options menu then offers it beside Workspace/Flat; the view groups Sessions by connected Thread (root Session title as the group heading, stage-ordered rows, latest-activity group order) and lists ungrouped Sessions flat by recency below. The ring requires the fork's `ui-workspace` seam; on a runtime without it the view simply never appears.

Artifacts are bounded references explicitly reported by the Agent (`file`, `directory`, `url`, `note`, or `other`). The plugin does not infer artifacts from arbitrary Tool or filesystem activity, and legacy Drafts/Links load with an empty artifact list.

## Development

```sh
pnpm install
pnpm run typecheck
pnpm run test
pnpm run build
```
