/**
 * dsh-provider-balance — browser half (served as /plugins/dsh-provider-balance/client.js).
 *
 * Hand-written client bundle in the DSH module handoff format: the classic
 * script registers one factory with window.__ModuleLoader__; the factory
 * resolves its few dependencies through the injected require (the frozen
 * platform module table — react and the shared UI primitives), injects its
 * stylesheet (the module system claims untagged <style> tags for this plugin
 * and removes them on unload), and exports the Cordis plugin.
 *
 * Contribution one: an entry in the `conversation.input.right` list slot —
 * the tool row inside the composer card, immediately left of the model select and
 * the context ring. The chip FOLLOWS the session's current model selection:
 * it reads the selected provider from the shared per-session model directory
 * (the same store ModelSelect renders from) and shows only that provider's
 * remaining quotas. A provider without a quota adapter renders nothing.
 *
 * Contribution two: one badge per configured provider row on the Models
 * settings page, mounted by DOM injection — no host slot required, so the
 * plugin runs identically on a stock upstream harness. A MutationObserver
 * watches for provider rows; for each one, the row's provider route id is
 * parsed from the edit button's accessible name ("编辑 {displayName}
 * ({provider})"), a foreign container is inserted next to the row's
 * actions, and ProviderBalanceRowBadge mounts into it through its own
 * react-dom/client root. The page's React tree is never modified: the
 * sweep re-asserts container positions after host reconciliations and
 * unmounts a badge's root the moment its row leaves the DOM. A provider
 * without a quota adapter renders nothing, so a misparsed or adapterless
 * row shows an invisible empty seat only.
 *
 * Data comes from the host half's same-origin JSON route
 * (`/provider-balance/quota?provider=<route-id>`); the API key never crosses
 * to the browser.
 */
window.__ModuleLoader__.load({
  id: 'dsh-provider-balance',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports

    var React = require('react')
    var createElement = React.createElement
    var useState = React.useState
    var useEffect = React.useEffect
    var useRef = React.useRef
    var useCallback = React.useCallback
    var createRoot = require('react-dom/client').createRoot
    var Tooltip = require('@deepseek-ai/dsh-client-ui-primitives').Tooltip

    /* ------------------------------------------------------------------ */
    /* Stylesheet (plain class names on a dpb- prefix; the module system   */
    /* claims this tag during materialization and drops it on unload).     */
    /* ------------------------------------------------------------------ */
    if (typeof document !== 'undefined'
      && document.querySelector('style[data-plugin-css="dsh-provider-balance/client.css"]') === null) {
      var style = document.createElement('style')
      style.dataset.plugin = 'dsh-provider-balance'
      style.dataset.pluginCss = 'dsh-provider-balance/client.css'
      style.textContent = [
        '.dpb-root { position: relative; display: inline-flex; }',
        '.dpb-trigger {',
        '  display: inline-flex; align-items: center; gap: 4px; flex: none;',
        '  height: 28px; padding: 0 8px; margin-right: 2px;',
        '  border: none; border-radius: 999px; background: transparent;',
        '  color: var(--dsw-alias-label-secondary); cursor: pointer;',
        /* Typography identical to the sibling ModelSelect trigger: 13/20
         * medium, so the chip's text reads on the same baseline as the model
         * name beside it. */
        '  font-size: 13px; line-height: 20px; font-weight: 500; font-variant-numeric: tabular-nums;',
        '  white-space: nowrap;',
        '}',
        '.dpb-trigger:hover { background: var(--dsw-alias-interactive-bg-hover); }',
        /* Settings-row variant (Models page provider rows): the row's dense
         * 28px capsule vocabulary rather than the composer's tool row. */
        '.dpb-trigger.dpb-compact { height: 22px; padding: 0 6px; font-size: 12px; line-height: 18px; }',
        '.dpb-num { color: var(--dpb-tint, var(--dsw-alias-label-primary)); font-weight: 500; }',
        '.dpb-sep { color: var(--dsw-alias-label-tertiary); }',
        '.dpb-tools { color: var(--dsw-alias-label-secondary); font-weight: 400; }',
        '.dpb-level-ok { --dpb-tint: var(--dsw-alias-label-primary); }',
        '.dpb-level-warn { --dpb-tint: var(--dsw-static-amber-500); }',
        '.dpb-level-low { --dpb-tint: var(--dsw-static-red-500); }',
        '.dpb-panel {',
        '  position: absolute; bottom: calc(100% + 8px); right: 0; z-index: 100;',
        '  box-sizing: border-box; width: 288px; padding: 12px;',
        '  border: 1px solid var(--dsw-alias-border-inverted); border-radius: 12px;',
        /* Generic-web --dsw-specific-menu is a 58%-alpha fill that upstream
         * pairs with a backdrop blur (MenuSurface); this hand-rolled panel has
         * no blur, so over conversation text it reads see-through (unreadable
         * numbers in light mode). Paint the SOLID equivalents of the darwin
         * nearly-opaque fills instead: f8f9fa/303136 are the menu-group-header
         * tokens' rgb at full alpha. */
        '  background: #f8f9fa; box-shadow: var(--dsw-shadow-lv3);',
        '  font-size: 12px; line-height: 20px; color: var(--dsw-alias-label-secondary);',
        '  cursor: default;',
        '}',
        '[data-ds-dark-theme] .dpb-panel { background: #303136; }',
        /* Settings-row variant: the badge sits in a provider row high in the
         * panel, so its popover opens DOWNWARD from the trigger. */
        '.dpb-panel.dpb-panel-down { top: calc(100% + 6px); bottom: auto; left: 0; right: auto; }',
        '.dpb-head { display: flex; align-items: center; gap: 6px; padding-right: 24px; }',
        '.dpb-title { font-weight: 500; color: var(--dsw-alias-label-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
        '.dpb-sub { color: var(--dsw-alias-label-tertiary); font-size: 11px; }',
        '.dpb-refresh {',
        '  position: absolute; top: 8px; right: 8px; width: 22px; height: 22px;',
        '  display: grid; place-items: center; border: none; border-radius: 999px;',
        '  background: transparent; color: var(--dsw-alias-label-tertiary); cursor: pointer;',
        '}',
        '.dpb-refresh:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }',
        '.dpb-refresh:disabled { cursor: default; opacity: 0.5; }',
        '.dpb-refresh:disabled:hover { background: transparent; }',
        '.dpb-row { margin-top: 8px; }',
        '.dpb-rowhead { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }',
        '.dpb-rowlabel { color: var(--dsw-alias-label-secondary); }',
        '.dpb-rowvalue { font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-primary); }',
        '.dpb-hint { color: var(--dsw-alias-label-tertiary); font-size: 11px; text-align: right; }',
        '.dpb-bar { display: flex; gap: 1px; margin-top: 4px; height: 4px; border-radius: 999px;',
        '  background: var(--dsw-alias-interactive-bg-hover); overflow: hidden; }',
        '.dpb-barused { flex: none; height: 100%; border-radius: 1px; background: var(--dpb-row-tint, var(--dsw-alias-label-tertiary)); }',
        /* Per-window identity tints: blue = 5h, green = weekly, purple = tools.
           Purple has no design-platform static token (same as ContextMeter's
           violet-400 literal). */
        '.dpb-c-blue { --dpb-row-tint: var(--dsw-static-blue-450); }',
        '.dpb-c-green { --dpb-row-tint: var(--dsw-static-green-500); }',
        '.dpb-c-purple { --dpb-row-tint: rgb(167, 139, 250); }',
        '.dpb-swatch { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 6px; background: var(--dpb-row-tint); vertical-align: baseline; }',
        '.dpb-breakdown { margin-top: 2px; color: var(--dsw-alias-label-tertiary); font-size: 11px;',
        '  font-variant-numeric: tabular-nums; }',
        '.dpb-stale { margin-top: 10px; color: var(--dsw-static-amber-500); font-size: 11px; }',
        '.dpb-error { margin-top: 6px; color: var(--dsw-static-red-500); font-size: 11px; }',
        '.dpb-foot { margin-top: 10px; color: var(--dsw-alias-label-tertiary); font-size: 11px;',
        '  display: flex; align-items: center; justify-content: space-between; gap: 8px; }',
      ].join('\n')
      document.head.appendChild(style)
    }

    /* ------------------------------------------------------------------ */
    /* Copy. One namespace, zh + en dictionaries; registered on ctx.locale */
    /* and delivered to the slot component as the `t` prop.                */
    /* ------------------------------------------------------------------ */
    var NS = 'providerBalance'
    var DICTS = {
      zh: {
        'chip.title': '供应商余量',
        'chip.5h': '5小时',
        'chip.week': '本周',
        'chip.tools': '工具',
        'panel.5h': '5 小时窗口',
        'panel.week': '本周窗口',
        'panel.month': '本月窗口',
        'panel.tools': '工具 / 网页搜索',
        'panel.remaining': '剩余',
        'panel.used': '已用',
        'panel.calls': '次',
        'panel.resetIn': '后重置',
        'panel.resetAt': '重置于',
        'panel.refreshedAt': '更新于',
        'panel.stale': '数据可能已过期（上次成功获取后刷新失败）',
        'panel.refresh': '刷新',
        'error.missing-key': '未配置 API Key（凭据或环境变量）',
        'error.auth': 'API Key 被拒绝，请检查供应商凭据',
        'error.http': '上游接口返回错误',
        'error.timeout': '请求超时',
        'error.network': '网络错误',
        'error.parse': '响应格式异常',
        'error.unknown': '未知错误',
        'error.fetch': '读取余量失败',
      },
      en: {
        'chip.title': 'Provider balance',
        'chip.5h': '5h',
        'chip.week': 'week',
        'chip.tools': 'tools',
        'panel.5h': '5-hour window',
        'panel.week': 'Weekly window',
        'panel.month': 'Monthly window',
        'panel.tools': 'Tools / web search',
        'panel.remaining': 'left',
        'panel.used': 'used',
        'panel.calls': 'calls',
        'panel.resetIn': 'to reset',
        'panel.resetAt': 'resets',
        'panel.refreshedAt': 'updated',
        'panel.stale': 'Data may be stale (last refresh failed)',
        'panel.refresh': 'Refresh',
        'error.missing-key': 'API key not configured (credential or env)',
        'error.auth': 'API key rejected; check the provider credential',
        'error.http': 'Upstream endpoint error',
        'error.timeout': 'Request timed out',
        'error.network': 'Network error',
        'error.parse': 'Unexpected response shape',
        'error.unknown': 'Unknown error',
        'error.fetch': 'Failed to load balance',
      },
    }

    var QUOTA_URL = '/provider-balance/quota'
    var POLL_MS = 5 * 60 * 1000
    /* A failed load retries quickly a few times before settling back into the
     * slow poll, so a transient blip does not pin the badge on "!" for five
     * minutes. */
    var RETRY_MS = 30 * 1000
    var MAX_RETRIES = 3

    /** DSH provider route id → display label. Route identity, not business
     * data: shown only when the upstream API returns no product name. */
    var SHORT_NAMES = { 'zai-coding-cn': 'GLM', 'kimi-coding': 'Kimi Code', 'opencode-go': 'OpenCode Go', 'deepseek-official': 'DeepSeek', 'moonshot-platform': 'Moonshot', 'xai': 'xAI' }

    /** Remaining-percent → visual level class. */
    function levelOf(remainingPercent) {
      if (remainingPercent === undefined) return 'dpb-level-ok'
      if (remainingPercent < 20) return 'dpb-level-low'
      if (remainingPercent < 50) return 'dpb-level-warn'
      return 'dpb-level-ok'
    }

    /** Compact "1h 23m" / "2d 4h" countdown for epoch-ms deadlines. */
    function formatCountdown(resetAt, now) {
      if (typeof resetAt !== 'number') return ''
      var ms = resetAt - now
      if (ms <= 0) return ''
      var minutes = Math.floor(ms / 60000)
      var days = Math.floor(minutes / 1440)
      var hours = Math.floor((minutes % 1440) / 60)
      var mins = minutes % 60
      if (days > 0) return days + 'd ' + hours + 'h'
      if (hours > 0) return hours + 'h ' + mins + 'm'
      return mins + 'm'
    }

    function formatClock(iso) {
      var date = new Date(iso)
      if (Number.isNaN(date.getTime())) return ''
      var pad = function (n) { return (n < 10 ? '0' : '') + n }
      return pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds())
    }

    function formatDate(resetAt) {
      var date = new Date(resetAt)
      if (Number.isNaN(date.getTime())) return ''
      var pad = function (n) { return (n < 10 ? '0' : '') + n }
      return date.getMonth() + 1 + '-' + pad(date.getDate())
    }

    function errorMessage(error, t) {
      if (error === undefined || error === null) return ''
      var key = 'error.' + String(error.code || 'unknown')
      return t(key in DICTS.zh ? key : 'error.unknown') + (error.message ? ': ' + error.message : '')
    }

    function labelWithSwatch(label) {
      return [
        createElement('span', { key: 'sw', className: 'dpb-swatch', 'aria-hidden': 'true' }),
        label,
      ]
    }

    /* ------------------------------------------------------------------ */
    /* Panel rows.                                                        */
    /* ------------------------------------------------------------------ */
    function WindowRow(props) {
      var label = props.label
      var value = props.value /* QuotaWindow */
      var t = props.t
      var now = props.now
      if (value === undefined || value === null) return null
      var remaining = value.remainingPercent
      var countdown = formatCountdown(value.resetAt, now)
      /* A non-ok upstream window status rides along on the hint line. */
      var status = typeof value.status === 'string' && value.status !== 'ok' ? ' · ' + value.status : ''
      var usedText = t('panel.remaining') + ' ' + remaining + '%'
      if (value.totalTokens !== undefined && value.totalTokens > 0) {
        usedText += ' · ' + t('panel.used') + ' ' + Math.round(value.usedPercent) + '%'
      }
      return createElement('div', { className: 'dpb-row ' + (props.colorClass || '') },
        createElement('div', { className: 'dpb-rowhead' },
          createElement('span', { className: 'dpb-rowlabel' }, labelWithSwatch(label)),
          createElement('span', { className: 'dpb-rowvalue' }, usedText)),
        createElement('div', { className: 'dpb-bar' },
          createElement('div', { className: 'dpb-barused', style: { width: Math.max(2, value.usedPercent) + '%' } })),
        countdown
          ? createElement('div', { className: 'dpb-hint' }, countdown + ' ' + t('panel.resetIn') + status)
          : (status ? createElement('div', { className: 'dpb-hint' }, status.slice(3)) : null))
    }

    /* Prepaid balance row. Text colors stay the panel defaults (same as every
     * other row); only the identity SWATCH is green, like the window rows'
     * blue/green/purple swatches. */
    function BalanceRow(props) {
      var balance = props.balance
      if (balance == null) return null
      var symbol = balance.currency === 'USD' ? '$' : '¥'
      var parts = []
      if (balance.granted != null && isFinite(balance.granted)) parts.push('赠金 ' + symbol + balance.granted.toFixed(2))
      if (balance.toppedUp != null && isFinite(balance.toppedUp)) parts.push('充值 ' + symbol + balance.toppedUp.toFixed(2))
      if (balance.usedToday != null && isFinite(balance.usedToday)) parts.push('今日已用 ' + symbol + balance.usedToday.toFixed(2))
      return createElement('div', { className: 'dpb-row dpb-c-green' },
        createElement('div', { className: 'dpb-rowhead' },
          createElement('span', { className: 'dpb-rowlabel' },
            labelWithSwatch(balance.currency === 'USD' ? '余额 (USD)' : '余额 (CNY)')),
          createElement('span', { className: 'dpb-rowvalue' },
            symbol + (isFinite(balance.total) ? balance.total.toFixed(2) : '—'))),
        parts.length > 0
          ? createElement('div', { className: 'dpb-breakdown' }, parts.join(' · '))
          : null,
        balance.isAvailable === false
          ? createElement('div', { className: 'dpb-breakdown' }, '余额不可用于 API 调用')
          : null)
    }

    function ToolsRow(props) {
      var t = props.t
      var tools = props.tools
      if (tools === undefined || tools === null) return null
      var breakdown = (tools.breakdown || []).map(function (item) { return item.code + ' ' + item.used }).join(' · ')
      return createElement('div', { className: 'dpb-row dpb-c-purple' },
        createElement('div', { className: 'dpb-rowhead' },
          createElement('span', { className: 'dpb-rowlabel' }, labelWithSwatch(t('panel.tools'))),
          createElement('span', { className: 'dpb-rowvalue' },
            t('panel.remaining') + ' ' + tools.remaining + '/' + tools.limit + ' ' + t('panel.calls'))),
        tools.limit > 0
          ? createElement('div', { className: 'dpb-bar' },
              createElement('div', { className: 'dpb-barused', style: { width: Math.max(2, Math.min(100, (tools.used / tools.limit) * 100)) + '%' } }))
          : null,
        breakdown
          ? createElement('div', { className: 'dpb-breakdown' }, breakdown)
          : null,
        typeof tools.resetAt === 'number'
          ? createElement('div', { className: 'dpb-hint' }, t('panel.resetAt') + ' ' + formatDate(tools.resetAt))
          : null)
    }

    /* ------------------------------------------------------------------ */
    /* Quota feed for one provider route: first load, gentle polling, and */
    /* failure-as-error folding. Shared by every badge surface; the       */
    /* provider is an explicit input, so each surface decides where it    */
    /* comes from (session selection on the composer, the row's owner     */
    /* share on the Models page).                                         */
    /* ------------------------------------------------------------------ */
    function useProviderQuota(provider) {
      var dataState = useState(null)
      var data = dataState[0]
      var setData = dataState[1]
      var loadingState = useState(false)
      var loading = loadingState[0]
      var setLoading = loadingState[1]

      var load = useCallback(function (force) {
        if (provider === undefined) return Promise.resolve(null)
        setLoading(true)
        return fetch(QUOTA_URL + '?provider=' + encodeURIComponent(provider) + (force ? '&refresh=1' : ''), {
          headers: { Accept: 'application/json' },
        })
          .then(function (response) {
            if (!response.ok) throw new Error('HTTP ' + response.status)
            return response.json()
          })
          .then(function (body) {
            var sources = (body && body.sources) || []
            var folded = sources.length > 0
              ? Object.assign({ provider: provider }, sources[0])
              : { provider: provider, unsupported: true }
            setData(folded)
            return folded
          })
          .catch(function () {
            var folded = { provider: provider, ok: false, error: { code: 'fetch', message: '' } }
            setData(folded)
            return folded
          })
          .finally(function () { setLoading(false) })
      }, [provider])

      /* Provider switch resets the badge; first load + gentle polling, with
       * quick retries while the last load failed. */
      useEffect(function () {
        setData(null)
        if (provider === undefined) return undefined
        var stopped = false
        var retries = 0
        var timer
        var run = function () {
          if (stopped) return
          load(false).then(function (folded) {
            if (stopped) return
            if (folded !== null && folded.ok === false && retries < MAX_RETRIES) {
              retries += 1
              timer = setTimeout(run, RETRY_MS)
            } else {
              retries = 0
              timer = setTimeout(run, POLL_MS)
            }
          })
        }
        run()
        return function () { stopped = true; clearTimeout(timer) }
      }, [provider, load])

      return { data: data, loading: loading, refresh: load }
    }

    /* ------------------------------------------------------------------ */
    /* Open popover state shared by every badge surface: outside click /  */
    /* Escape close (ContextMeter's pattern), plus a slow clock while the */
    /* panel is open so countdowns stay fresh.                            */
    /* ------------------------------------------------------------------ */
    function usePopoverPanel() {
      var openState = useState(false)
      var open = openState[0]
      var setOpen = openState[1]
      var tickState = useState(0)
      var setTick = tickState[1]
      var rootRef = useRef(null)

      /* Slow clock while the panel is open. */
      useEffect(function () {
        if (!open) return undefined
        var timer = setInterval(function () { setTick(function (n) { return n + 1 }) }, 30 * 1000)
        return function () { clearInterval(timer) }
      }, [open])

      /* Outside click / Escape close. */
      useEffect(function () {
        if (!open) return undefined
        var onPointerDown = function (event) {
          if (rootRef.current !== null && event.target instanceof Node && rootRef.current.contains(event.target)) return
          setOpen(false)
        }
        var onKeyDown = function (event) {
          if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('pointerdown', onPointerDown)
        document.addEventListener('keydown', onKeyDown)
        return function () {
          document.removeEventListener('pointerdown', onPointerDown)
          document.removeEventListener('keydown', onKeyDown)
        }
      }, [open])

      return { open: open, setOpen: setOpen, tick: tickState[0], rootRef: rootRef }
    }

    /* ------------------------------------------------------------------ */
    /* The badge surface: one provider's chip + detail panel. `data` is   */
    /* the host snapshot for exactly that provider; a provider without a  */
    /* quota adapter renders nothing at all.                              */
    /* ------------------------------------------------------------------ */
    function ProviderBalanceBadge(props) {
      var t = props.t
      var provider = props.provider

      var quota = useProviderQuota(provider)
      var panel = usePopoverPanel()
      var data = quota.data
      var loading = quota.loading
      var open = panel.open
      var setOpen = panel.setOpen
      var rootRef = panel.rootRef

      /* A provider swap under a live badge closes its panel. */
      useEffect(function () { setOpen(false) }, [provider])

      /* No provider, or the provider has no quota adapter: no badge. */
      if (provider === undefined || data === null || data.unsupported === true) return null

      var now = Date.now()
      var name = (data.plan && data.plan.name) || SHORT_NAMES[data.provider] || data.provider
      var sessionLeft = data.session ? data.session.remainingPercent : undefined
      var weeklyLeft = data.weekly ? data.weekly.remainingPercent : undefined
      var tools = data.tools
      var balances = Array.isArray(data.balances) ? data.balances : []

      /* Chip is a single number: prepaid amount, or the 5h window. Week /
       * month / tools stay in the click panel so the compact figure does
       * not change meaning from one refresh to the next. */
      var chipBody = []
      if (balances.length > 0) {
        var b = balances[0]
        var bsym = b.currency === 'USD' ? '$' : '¥'
        chipBody.push(createElement('span', { key: 'bal', className: 'dpb-num' },
          bsym + (isFinite(b.total) ? b.total.toFixed(2) : '—')))
      } else if (sessionLeft !== undefined) {
        chipBody.push(createElement('span', { key: 's', className: levelOf(sessionLeft) },
          createElement('span', { className: 'dpb-num' }, sessionLeft + '%')))
      }
      if (chipBody.length === 0) chipBody.push(createElement('span', { key: 'x', className: 'dpb-num' }, '!'))

      var tooltipText = data.ok !== true
        ? name + ' · ' + errorMessage(data.error, t)
        : balances.length > 0
          ? name + ' · 余额 ' + (balances[0].currency === 'USD' ? '$' : '¥') + (isFinite(balances[0].total) ? balances[0].total.toFixed(2) : '—')
          : name + ' · ' + t('chip.5h') + ' ' + (sessionLeft !== undefined ? sessionLeft + '%' : '—')
            + ' · ' + t('chip.week') + ' ' + (weeklyLeft !== undefined ? weeklyLeft + '%' : '—')
            + (tools !== undefined ? ' · ' + t('chip.tools') + ' ' + tools.remaining : '')

      var rows = []
      if (data.ok !== true) {
        rows.push(createElement('div', { key: 'err', className: 'dpb-error' }, errorMessage(data.error, t)))
      } else {
        balances.forEach(function (balance, index) {
          rows.push(createElement(BalanceRow, { key: 'bal' + index, balance: balance, t: t }))
        })
        rows.push(createElement(WindowRow, { key: '5h', label: t('panel.5h'), value: data.session, t: t, now: now, colorClass: 'dpb-c-blue' }))
        rows.push(createElement(WindowRow, { key: 'week', label: t('panel.week'), value: data.weekly, t: t, now: now, colorClass: 'dpb-c-green' }))
        /* Monthly window: OpenCode Go reports it; other providers omit it. */
        rows.push(createElement(WindowRow, { key: 'month', label: t('panel.month'), value: data.monthly, t: t, now: now, colorClass: 'dpb-c-purple' }))
        rows.push(createElement(ToolsRow, { key: 'tools', tools: tools, t: t }))
        if (data.stale) {
          rows.push(createElement('div', { key: 'stale', className: 'dpb-stale' }, t('panel.stale')))
        }
      }

      return createElement('span', { ref: rootRef, className: 'dpb-root' },
        createElement(Tooltip, { label: tooltipText, side: 'top', delayMs: 200, disabled: open },
          createElement('button', {
            type: 'button',
            className: 'dpb-trigger' + (props.compact ? ' dpb-compact' : ''),
            'aria-label': t('chip.title'),
            'aria-haspopup': 'dialog',
            'aria-expanded': open,
            onClick: function () { setOpen(!open) },
          }, chipBody)),
        open && createElement('div', {
          className: 'dpb-panel' + (props.panelDown ? ' dpb-panel-down' : ''),
          role: 'dialog',
          'aria-label': t('chip.title'),
          key: 'panel-' + panel.tick,
        },
          createElement('div', { className: 'dpb-head' },
            createElement('span', { className: 'dpb-title' }, name),
            data.plan && data.plan.level
              ? createElement('span', { className: 'dpb-sub' }, String(data.plan.level))
              : null,
            data.plan && data.plan.renewDate
              ? createElement('span', { className: 'dpb-sub' }, '↻ ' + data.plan.renewDate)
              : null),
          createElement('button', {
            type: 'button',
            className: 'dpb-refresh',
            'aria-label': t('panel.refresh'),
            title: t('panel.refresh'),
            disabled: loading,
            onClick: function () { quota.refresh(true) },
          }, loading ? '…' : '↻'),
          rows,
          data.fetchedAt
            ? createElement('div', { className: 'dpb-foot' },
                createElement('span', null, t('panel.refreshedAt') + ' ' + formatClock(data.fetchedAt)),
                createElement('span', { className: 'dpb-sub' }, SHORT_NAMES[data.provider] || data.provider))
            : null))
    }

    /* ------------------------------------------------------------------ */
    /* The composer chip: follows the session's CURRENT model provider,    */
    /* live from the shared per-session model directory (the same store    */
    /* ModelSelect renders from).                                          */
    /* ------------------------------------------------------------------ */
    function ProviderBalanceChip(props) {
      var sessionId = props.sessionId

      var providerState = useState(undefined)
      var provider = providerState[0]
      var setProvider = providerState[1]

      /* modelDirectories is resolved lazily per effect run: the service may
       * activate after this plugin loads. */
      var getModelDirectories = props.getModelDirectories

      useEffect(function () {
        var directories = getModelDirectories()
        if (directories === undefined) return undefined
        var directory
        try {
          directory = directories.directoryFor(sessionId)
        } catch (error) {
          return undefined
        }
        var read = function () {
          var current = directory.store.getSnapshot().current
          setProvider(current !== null && current !== undefined ? current.provider : undefined)
        }
        read()
        return directory.store.subscribe(read)
      }, [sessionId])

      if (provider === undefined) return null
      return createElement(ProviderBalanceBadge, { provider: provider, t: props.t })
    }

    /* The Models settings row badge: the provider route id arrives from the
     * row's edit-button accessible name (see the watcher below), so the
     * badge is stationary per row and needs no subscription. The row's
     * displayName is not consumed: the panel already names the plan or
     * falls back to the route label. */
    function ProviderBalanceRowBadge(props) {
      return createElement(ProviderBalanceBadge, {
        provider: props.provider,
        t: props.t,
        compact: true,
        panelDown: true,
      })
    }

    /* ------------------------------------------------------------------ */
    /* Models-page row badges via DOM injection: ProviderBalanceRowBadge   */
    /* mounted through its own React root into a container inserted next   */
    /* to each provider row's actions. This is the plugin's only row-badge */
    /* path — no host slot is required, and it must never touch the host   */
    /* React tree: the container is a foreign node the page never manages, */
    /* the badge inside is a self-contained root.                          */
    /* ------------------------------------------------------------------ */

    /* The edit button's accessible name is providerCopy(t('editProvider')) =
     * "编辑 {label}" / "Edit {label}" where label is "displayName (provider)"
     * or bare "provider" — the row's stable route id rides inside, so no
     * display-name guessing is involved. */
    var EDIT_LABEL_PREFIXES = ['编辑 ', 'Edit ']
    var ROUTE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

    function parseProviderFromEditLabel(label) {
      for (var i = 0; i < EDIT_LABEL_PREFIXES.length; i++) {
        var prefix = EDIT_LABEL_PREFIXES[i]
        if (label.indexOf(prefix) !== 0) continue
        var rest = label.slice(prefix.length)
        var open = rest.lastIndexOf('(')
        if (open >= 0 && rest.charAt(rest.length - 1) === ')') {
          var inside = rest.slice(open + 1, rest.length - 1)
          return ROUTE_ID_RE.test(inside) ? inside : undefined
        }
        return ROUTE_ID_RE.test(rest) ? rest : undefined
      }
      return undefined
    }

    /* Watch the page for provider rows and mount/dismount badges. The sweep
     * is coalesced (one per 50ms burst) because host React mutations arrive
     * in storms; each sweep re-asserts container positions so a host
     * reconciliation that moved the row's children puts the seat back. */
    function createRowBadgeWatcher(t) {
      var entries = new Map() /* edit button → { container, root, actions } */
      var timer = null
      var disposed = false

      var sweep = function () {
        timer = null
        if (disposed) return
        entries.forEach(function (entry, button) {
          if (!button.isConnected) {
            entry.root.unmount()
            if (entry.container.parentNode !== null) entry.container.remove()
            entries.delete(button)
          } else if (entry.container.nextSibling !== entry.actions) {
            entry.actions.parentNode.insertBefore(entry.container, entry.actions)
          }
        })
        var buttons = document.querySelectorAll('button[aria-label]')
        for (var i = 0; i < buttons.length; i++) {
          var button = buttons[i]
          if (entries.has(button)) continue
          var provider = parseProviderFromEditLabel(button.getAttribute('aria-label') || '')
          var actions = button.parentElement
          if (provider === undefined || actions === null || actions.parentElement === null) continue
          /* Idempotence across watcher instances: hosts that re-apply this
           * plugin in place (the desktop shell's client-HMR receiver
           * re-evaluates the bundle on file change WITHOUT disposing the
           * previous instance's foreign DOM) leave earlier seats standing.
           * Seat presence — not the button element, which only this
           * instance's entries map knows — is the dedupe key, so N applies
           * produce exactly one seat per row. A stale seat keeps rendering
           * through its own root (the quota route is process-level), so
           * skipping it is safe; a full page reload resets everything. */
          var head = actions.parentElement
          var siblings = head.children
          var seated = false
          for (var j = 0; j < siblings.length; j++) {
            var sibling = siblings[j]
            if (sibling.dataset !== undefined && sibling.dataset.dpbRowSeat !== undefined) {
              seated = true
              break
            }
          }
          if (seated) continue
          var container = document.createElement('span')
          container.dataset.dpbRowSeat = provider
          head.insertBefore(container, actions)
          var root = createRoot(container)
          root.render(createElement(ProviderBalanceRowBadge, { provider: provider, t: t }))
          entries.set(button, { container: container, root: root, actions: actions })
        }
      }

      var schedule = function () {
        if (disposed || timer !== null) return
        timer = setTimeout(sweep, 50)
      }

      var observer = new MutationObserver(schedule)
      observer.observe(document.body, { childList: true, subtree: true })
      schedule()

      return function dispose() {
        disposed = true
        observer.disconnect()
        if (timer !== null) clearTimeout(timer)
        entries.forEach(function (entry) {
          entry.root.unmount()
          if (entry.container.parentNode !== null) entry.container.remove()
        })
        entries.clear()
      }
    }

    /* ------------------------------------------------------------------ */
    /* Cordis plugin: dictionaries, the composer slot entry, and the      */
    /* row-badge watcher.                                                 */
    /* ------------------------------------------------------------------ */
    module.exports = {
      name: 'dsh-provider-balance',
      inject: ['slots', 'locale'],
      apply: function apply(ctx) {
        ctx.effect(function () {
          return ctx.locale.register(NS, DICTS)
        }, 'provider-balance: dictionaries')

        /* Lazy service access handed to the slot component: the model
         * directory service may activate after this plugin loads. */
        var getModelDirectories = function () { return ctx.get('modelDirectories') }

        ctx.slots.inject('conversation.input.right', function () {
          return ctx.slots.register({
            name: 'conversation.input.right',
            id: 'provider-balance',
            order: 10,
            locale: NS,
            inject: function () { return { getModelDirectories: getModelDirectories } },
          }, ProviderBalanceChip)
        })

        /* Models settings page: one badge per configured provider row,
         * DOM-injected (see createRowBadgeWatcher). No host slot is
         * required, so this runs on stock and forked harnesses alike and
         * the plugin never needs source changes upstream. */
        ctx.effect(function () {
          return createRowBadgeWatcher(ctx.locale.bind(NS))
        }, 'provider-balance: row badges')
      },
    }

    return module.exports
  },
})
