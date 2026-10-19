# 上游 Discussion 草稿：frontend-static 显式 content-length（WKWebView 回环停滞）

> 状态：**草稿——凭用户确认后**经 `gh api graphql` 的 `createDiscussion`（分类 General）提交至 `deepseek-ai/deepseek-harness`。先例：#3007（WKWebView chunked 响应）、#3099（会话持久化并发写者），均附 fork 修复链接。

---

**标题建议**：`frontend-static: WKWebView randomly stalls on loopback responses without an explicit Content-Length`

**正文（英文）**：

## Symptom

On macOS, a WKWebView loading the web UI over loopback (`http://127.0.0.1:<port>`) intermittently shows a blank window at startup — the index document never finishes loading. The same server responds instantly to curl, and the failure is not reproducible in Safari/Chromium against the same URL, which made it look nondeterministic and environment-specific.

## Root cause

`serveStatic` in `packages/host/frontend-static` writes the response with only `content-type`:

```ts
res.writeHead(200, { 'content-type': type })
res.end(body)
```

With no `Content-Length`, Node answers with `Transfer-Encoding: chunked`. WKWebView's URL-loading path occasionally stalls on **loopback chunked responses** — the same hazard the bundle route in `dsh-client-modules` already guards against (that route sets an explicit content-length for exactly this class of failure). The index carries the boot manifest, so a stalled index is a blank window with no diagnostics.

## Fix (carried in our fork since the 0.1.x line)

```ts
const length = typeof body === 'string' ? Buffer.byteLength(body) : body.length
res.writeHead(200, { 'content-type': type, 'content-length': length })
res.end(body)
```

A four-line change; both GET and HEAD paths benefit (HEAD responses now advertise the same length). We have run this in production on the desktop distribution without observing the stall again.

**Fork link**: https://github.com/aka-danielZhang/deepseek-harness (see `packages/host/frontend-static/src/index.ts` on the `feature/upstream-0.2.1-rc.2` branch, commit history for the original fix).

Happy to send a PR-shaped patch or a test if the team prefers — our fork's integration test asserts `Number(res.headers['content-length']) > 0` for the index HEAD.

---

**提交方式备忘**（确认后执行）：

```sh
gh api graphql -f query='
mutation { createDiscussion(input: {
  repositoryId: "<repo-node-id>",
  categoryId: "<General-category-id>",
  title: "frontend-static: WKWebView randomly stalls on loopback responses without an explicit Content-Length",
  body: "<正文>"
}) { discussion { url } } }'
```
