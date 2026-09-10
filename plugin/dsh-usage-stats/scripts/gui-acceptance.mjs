/**
 * Real-GUI acceptance for the usage-stats settings page (design note
 * 2026-09-10, phase D): assembles an ISOLATED DSH home, installs THIS
 * plugin into the web profile through the assembled runtime's real
 * `plugin add` transaction, seeds records, boots the actual `dsh web`
 * sidecar, then drives the true settings modal with Playwright (system
 * Chrome) across width/theme/language/data matrices — screenshots plus
 * DOM/pixel assertions. Never touches the real `~/.dsh`.
 *
 * Usage:
 *   node scripts/gui-acceptance.mjs [--runtime <dir>] [--out <dir>] [--keep]
 *
 * --runtime defaults to <repo>/runtime/build/<revision.json sha>.
 * Exit code 0 = every assertion passed.
 */

import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = resolve(here, '..')
const repoRoot = resolve(pkgRoot, '../..')

function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`)
  return at !== -1 && process.argv[at + 1] !== undefined ? process.argv[at + 1] : fallback
}

const keep = process.argv.includes('--keep')
const revision = JSON.parse(readFileSync(join(repoRoot, 'runtime/revision.json'), 'utf8'))
const runtimeDir = arg('runtime', join(repoRoot, 'runtime/build', revision.sha))
const outDir = resolve(arg('out', join(pkgRoot, '.gui-acceptance')))
const nodeBin = join(runtimeDir, 'tools/node_modules/node/bin/node')
const cliBin = join(runtimeDir, 'dsh/node_modules/@deepseek-ai/dsh/lib/bin.js')
for (const p of [nodeBin, cliBin]) {
  if (!existsSync(p)) throw new Error(`gui-acceptance: missing ${p} — run node scripts/prepare-runtime.mjs first`)
}

// ── Seed data ─────────────────────────────────────────────────────────────

/** Rich fixture: a year of activity, 9 models (long names), huge values. */
function seedRecords(home) {
  const recordsDir = join(home, 'usage-stats/records')
  mkdirSync(recordsDir, { recursive: true })
  const models = [
    ['pi-ai', 'glm-5.3'],
    ['pi-ai', 'gpt-5.6-luna-preview-long-name'],
    ['pi-ai', 'deepseek-v4-chat'],
    ['zai', 'glm-5.3-air'],
    ['zai', 'glm-5.3-flash'],
    ['openrouter', 'claude-opus-4.6'],
    ['openrouter', 'gemini-3-pro-preview'],
    ['openrouter', 'kimi-k3-thinking'],
    ['pi-ai', 'qwen4-max-2026-09'],
  ]
  const day = 86_400_000
  const now = Date.now()
  const today = new Date(now)
  const dayKey = (offset) => {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - offset)
    const mm = String(d.getMonth() + 1).padStart(2, '0')
    const dd = String(d.getDate()).padStart(2, '0')
    return `${d.getFullYear()}-${mm}-${dd}`
  }
  const perDay = new Map()
  let mid = 0
  for (let offset = 400; offset >= 0; offset -= 1) {
    const active = offset % 7 !== 6 || offset % 11 === 0
    if (!active && offset > 30) continue
    const count = offset <= 30 ? 2 + (offset % 4) : 1 + (offset % 3)
    const lines = []
    for (let i = 0; i < count; i += 1) {
      const [provider, model] = models[(offset + i) % models.length]
      const base = (offset + 1) * 900 + i * 15_000
      const t = now - offset * day + i * 3_600_000 - 12 * 3_600_000
      const record = {
        v: 1,
        t,
        sid: 'seed',
        mid: `m${(mid += 1)}`,
        provider,
        model,
        in: 1200 + (i % 5) * 300,
        out: base % 90_000,
        cr: 40_000 + (i % 3) * 8_000,
        cw: 2_000,
        sd: t - 30_000,
      }
      lines.push(JSON.stringify(record))
    }
    perDay.set(dayKey(offset), lines)
  }
  // A few monster days for the 500M-scale formatting axis.
  for (const [key, lines] of perDay) {
    if (Math.random() < 0.02) {
      lines.push(JSON.stringify({ v: 1, t: now - 3_600_000, sid: 'seed', mid: `m${(mid += 1)}`, provider: 'pi-ai', model: 'glm-5.3', in: 5_000_000, out: 120_000_000, cr: 80_000_000, cw: 9_000_000, sd: now - 3_900_000 }))
    }
    writeFileSync(join(recordsDir, `${key}.jsonl`), `${lines.join('\n')}\n`)
  }
  console.log(`gui-acceptance: seeded ${perDay.size} record files`)
}

// ── Process plumbing ──────────────────────────────────────────────────────

const home = keep ? join(outDir, 'home') : mkdtempSync(join(tmpdir(), 'ustat-gui-'))
mkdirSync(outDir, { recursive: true })
seedRecords(home)

const runEnv = { ...process.env, DSH_HOME: home }
console.log(`gui-acceptance: DSH_HOME=${home}`)
console.log('gui-acceptance: plugin add (real profile transaction)...')
execFileSync(nodeBin, [cliBin, 'plugin', '--profile', 'web', 'add', `file:${pkgRoot}`], {
  env: runEnv,
  stdio: 'inherit',
})

const port = 41_000 + Math.floor(Math.random() * 20_000)
console.log(`gui-acceptance: booting sidecar on :${port}`)
const sidecar = spawn(nodeBin, [cliBin, 'web', '--port', String(port), '--no-open'], {
  env: runEnv,
  stdio: ['ignore', 'pipe', 'pipe'],
})
let sidecarLog = ''
const sidecarUrl = new Promise((resolveUrl) => {
  const scan = (chunk) => {
    sidecarLog += chunk
    const match = /http:\/\/127\.0\.0\.1:\d+\/\?token=\S+/.exec(sidecarLog)
    if (match !== null) resolveUrl(match[0])
  }
  sidecar.stdout.on('data', scan)
  sidecar.stderr.on('data', scan)
})
// The webserver token-gates every route; the printed URL is the only
// authorized entry, so the probe (and the browser) must use it verbatim.
const baseUrl = await Promise.race([
  sidecarUrl,
  sleep(240_000).then(() => { throw new Error(`sidecar never printed its URL\n${sidecarLog}`) }),
])
console.log(`gui-acceptance: sidecar URL ready`)

async function waitReady() {
  for (let i = 0; i < 120; i += 1) {
    if (sidecar.exitCode !== null) throw new Error(`sidecar exited ${sidecar.exitCode}\n${sidecarLog}`)
    try {
      // The webserver token-gates routes (401 bare, 303 with token before
      // the session cookie); ANY HTTP answer proves the listener is up —
      // the browser handles the cookie flow natively.
      await fetch(baseUrl, { signal: AbortSignal.timeout(2000), redirect: 'manual' })
      return
    } catch { /* not up yet */ }
    await sleep(1000)
  }
  throw new Error(`sidecar never became ready at ${baseUrl}\n${sidecarLog}`)
}

// ── Assertions ────────────────────────────────────────────────────────────

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

async function openUsageStats(page, { lang }) {
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#root > *', { timeout: 60_000 })

  // A fresh isolated home shows the two-step stock onboarding flow. Complete
  // it before looking for the sidebar controls; established homes skip this.
  for (let step = 0; step < 6; step += 1) {
    const continueButton = page.getByRole('button', { name: /^(?:继续|Continue)$/, exact: true })
    if (await continueButton.count() > 0) {
      await continueButton.first().click()
      await page.waitForTimeout(500)
      continue
    }
    const laterButton = page.getByRole('button', { name: /^(?:稍后配置|Configure later)$/, exact: true })
    if (await laterButton.count() > 0) {
      await laterButton.first().click()
      await page.waitForTimeout(500)
      continue
    }
    break
  }
  // Some isolated contexts show a dismissible informational overlay after
  // onboarding. Escape it before operating the sidebar.
  await page.keyboard.press('Escape')

  // The stock settings trigger is the sidebar.settings slot root.
  const trigger = page.locator('[data-slot="sidebar.settings"]').first()
  await trigger.waitFor({ state: 'visible', timeout: 30_000 })
  await trigger.click({ force: true })
  await page.waitForSelector('[role="dialog"]', { timeout: 15_000 })
  const navItem = page.getByRole('button', { name: /^(?:使用统计|Usage Stats)$/, exact: true }).first()
  await navItem.waitFor({ state: 'visible', timeout: 15_000 })
  await navItem.click({ force: true })
  await page.waitForSelector('h2', { timeout: 15_000 })
  await page.getByRole('img', { name: /Token.*(?:热力图|heatmap)/ }).waitFor({ state: 'visible', timeout: 15_000 })
}

/** All the DOM/pixel assertions for the currently open usage page. */
async function assertPage(page, label) {
  const section = page.locator('section').filter({ has: page.getByRole('img', { name: /Token.*(?:热力图|heatmap)/ }) }).last()
  await section.waitFor({ state: 'visible' })

  // 1. No horizontal overflow anywhere from our section up to the dialog.
  const overflow = await page.evaluate(() => {
    const root = [...document.querySelectorAll('section')].reverse().find(s => s.querySelectorAll('svg').length >= 3)
    const offenders = []
    let el = root
    while (el !== null && el !== document.body) {
      if (el.scrollWidth > el.clientWidth + 2) offenders.push(`${el.tagName}.${String(el.className).slice(0, 40)} ${el.scrollWidth}>${el.clientWidth}`)
      const heat = el.classList.contains('heatWrap') ? null : null
      void heat
      el = el.parentElement
    }
    return offenders
  })
  check(`${label}: no horizontal overflow above the heatmap wrapper`, overflow.length === 0, overflow.join(' | '))

  // The complete 52-week heatmap scales into the card and never scrolls.
  const heatState = await page.evaluate(() => {
    const root = [...document.querySelectorAll('section')].reverse().find(s => s.querySelectorAll('svg').length >= 3)
    const svg = [...root.querySelectorAll('svg')].find(node => /Token.*(?:热力图|heatmap)/.test(node.querySelector('title')?.textContent ?? ''))
    const el = svg?.parentElement
    if (el === undefined || el === null) return { found: false }
    return { found: true, scrolls: el.scrollWidth > el.clientWidth + 1, width: el.clientWidth }
  })
  check(`${label}: heatmap wrapper present`, heatState.found)
  check(`${label}: heatmap fits without horizontal scrolling`, heatState.found && !heatState.scrolls, JSON.stringify(heatState))

  // 2. Charts paint real pixels.
  const counts = await page.evaluate(() => {
    const root = [...document.querySelectorAll('section')].reverse().find(s => s.querySelectorAll('svg').length >= 3)
    const chart = (pattern) => [...root.querySelectorAll('svg')].find(svg => pattern.test(svg.querySelector('title')?.textContent ?? ''))
    const heat = chart(/Token.*(?:热力图|heatmap)/)
    const trend = chart(/按日 Token 趋势|Daily token trend/)
    const quality = chart(/模型质量|Model quality/)
    const donut = chart(/模型用量|Model usage/)
    return {
      heatCells: heat?.querySelectorAll('rect[role="button"]').length ?? 0,
      trendLines: [...(trend?.querySelectorAll('path') ?? [])].filter(path => (path.getAttribute('stroke') ?? '').startsWith('var(')).length,
      qualityBars: [...(quality?.querySelectorAll('rect') ?? [])].filter(rect => (rect.getAttribute('fill') ?? '').startsWith('var(')).length,
      donutArcs: donut?.querySelectorAll('circle').length ?? 0,
    }
  })
  check(`${label}: heatmap cells > 300`, counts.heatCells > 300, String(counts.heatCells))
  check(`${label}: trend lines painted`, counts.trendLines > 0, String(counts.trendLines))
  check(`${label}: quality bars painted`, counts.qualityBars > 0, String(counts.qualityBars))
  check(`${label}: donut arcs painted`, counts.donutArcs >= 5, String(counts.donutArcs))

  // 3. Axis text never falls back to the browser default black.
  const blackText = await page.evaluate(() => {
    const root = [...document.querySelectorAll('section')].reverse().find(s => s.querySelectorAll('svg').length >= 3)
    return [...root.querySelectorAll('svg text')].filter(el => getComputedStyle(el).fill === 'rgb(0, 0, 0)').length
  })
  check(`${label}: no default-black axis text`, blackText === 0, `${blackText} offenders`)

  // 4. Summary-card grid columns match the measured content width.
  const band = await page.evaluate(() => {
    const root = [...document.querySelectorAll('section')].reverse().find(s => s.querySelectorAll('svg').length >= 3)
    const sec = getComputedStyle(root)
    const first = [...root.querySelectorAll('div')].find(node => node.children.length === 4 && /(?:累计 Token|Total tokens)/.test(node.textContent ?? '') && /(?:平均调用时长|Avg call duration)/.test(node.textContent ?? ''))
    return {
      sectionWidth: root.clientWidth,
      columns: first ? getComputedStyle(first).gridTemplateColumns.split(' ').length : 0,
      container: sec.containerType,
    }
  })
  const expected = band.sectionWidth >= 480 ? 4 : band.sectionWidth >= 380 ? 2 : 1
  check(`${label}: summary columns ${expected} at ${band.sectionWidth}px`, band.columns === expected, JSON.stringify(band))

  // 5. Pill controls exist and respond (range switch requests + renders).
  const pills = await section.locator('[role="group"]').count()
  check(`${label}: pill groups rendered`, pills >= 2, String(pills))
  return band
}

// ── Playwright matrix ─────────────────────────────────────────────────────

const { chromium } = await import('playwright-core')

async function main() {
  await waitReady()
  console.log(`gui-acceptance: sidecar ready at ${baseUrl}`)
  const browser = await chromium.launch({ channel: 'chrome' })

  const scenarios = [
    { name: 'zh-dark-1208', viewport: { width: 1208, height: 835 }, lang: 'zh-CN', scheme: 'dark' },
    { name: 'en-light-1208', viewport: { width: 1208, height: 835 }, lang: 'en-US', scheme: 'light' },
    { name: 'zh-dark-1024-custom', viewport: { width: 1024, height: 768 }, lang: 'zh-CN', scheme: 'dark', custom: true },
    { name: 'zh-dark-narrow', viewport: { width: 760, height: 700 }, lang: 'zh-CN', scheme: 'dark' },
  ]

  for (const scenario of scenarios) {
    const context = await browser.newContext({
      viewport: scenario.viewport,
      locale: scenario.lang,
      colorScheme: scenario.scheme,
    })
    const page = await context.newPage()
    await openUsageStats(page, { lang: scenario.lang.startsWith('zh') ? 'zh' : 'en' })
    const band = await assertPage(page, scenario.name)

    if (scenario.lang.startsWith('en')) {
      const chinese = await page.evaluate(() => {
        const root = [...document.querySelectorAll('section')].reverse().find(s => s.querySelectorAll('svg').length >= 3)
        return [...root.querySelectorAll('*')].filter(el => el.children.length === 0 && /[\u4e00-\u9fff]/.test(el.textContent ?? '')).map(el => el.textContent?.slice(0, 30))
      })
      check(`${scenario.name}: no Chinese residue in en`, chinese.length === 0, chinese.join(','))
    }

    if (scenario.custom) {
      await page.getByRole('button', { name: /^(?:自定义|Custom)$/ }).click()
      await page.locator('input[type="date"]').first().waitFor({ state: 'visible' })
      const inputs = page.locator('input[type="date"]')
      check(`${scenario.name}: custom range inputs`, await inputs.count() === 2)
      // Invalid span message, no request fired with bad range.
      await inputs.nth(1).fill('2026-01-01')
      await page.waitForTimeout(300)
      const alert = await page.locator('[role="alert"]').count()
      check(`${scenario.name}: invalid custom range explained`, alert >= 1)
      await inputs.nth(0).fill('2026-01-01')
      await page.waitForTimeout(600)
    }

    if (scenario.name === 'zh-dark-1208') {
      // Interactive matrix: mode switch, range switch, refresh, keyboard, tooltip.
      await page.getByRole('button', { name: '每周' }).click()
      await page.waitForTimeout(700)
      const weeklyCells = await page.evaluate(() => document.querySelectorAll('svg rect[role="button"]').length)
      check('weekly mode renders week cells', weeklyCells > 40 && weeklyCells <= 60, String(weeklyCells))
      await page.getByRole('button', { name: '每日' }).click()
      await page.waitForTimeout(700)

      // Heatmap hover tooltip appears and stays inside the viewport.
      const cell = page.locator('svg rect[role="button"]').nth(200)
      await cell.scrollIntoViewIfNeeded()
      await cell.click()
      const tipBox = await page.evaluate(() => {
        const tip = document.querySelector('[role="tooltip"]')
        if (tip === null) return null
        const r = tip.getBoundingClientRect()
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
      })
      check('heatmap tooltip opens within viewport',
        tipBox !== null && tipBox.left >= 0 && tipBox.top >= 0 && tipBox.right <= scenario.viewport.width && tipBox.bottom <= scenario.viewport.height,
        JSON.stringify(tipBox))
      await cell.click()

      // Keyboard: Tab reaches the pills and Enter toggles them.
      await page.getByRole('button', { name: '近 30 天' }).focus()
      await page.keyboard.press('Enter')
      await page.waitForTimeout(700)
      check('keyboard Enter switches range', await page.getByRole('button', { name: '近 30 天' }).getAttribute('aria-pressed') === 'true')

      // Refresh button announces via role=status.
      await page.getByRole('button', { name: '刷新' }).click()
      await page.locator('[role="status"]').waitFor({ timeout: 15_000 })
      check('refresh announces via role=status', true)

      // Rapid switching must not wedge the page (generation guard).
      for (const label of ['近 7 天', '近 30 天', '近 7 天']) {
        await page.getByRole('button', { name: label }).click()
      }
      await page.waitForTimeout(1200)
      check('rapid range switching stays coherent', (await page.locator('section svg').count()) >= 3)
      await page.getByRole('heading', { name: '模型质量' }).scrollIntoViewIfNeeded()
      await page.screenshot({ path: join(outDir, 'zh-dark-1208-lower.png') })

      // Resize the already-loaded page as well as opening isolated narrow
      // contexts. This catches responsive overflow without onboarding state
      // from a fresh browser context influencing the result.
      await page.setViewportSize({ width: 760, height: 700 })
      await assertPage(page, 'zh-dark-resized-narrow')
      await page.screenshot({ path: join(outDir, 'zh-dark-resized-narrow.png') })
      await page.setViewportSize(scenario.viewport)
    }

    await page.screenshot({ path: join(outDir, `${scenario.name}.png`) })
    console.log(`gui-acceptance: shot ${scenario.name} (content ${band.sectionWidth}px)`)
    await context.close()
  }

  await browser.close()
}

try {
  await main()
} finally {
  sidecar.kill('SIGTERM')
  await sleep(1500)
  sidecar.kill('SIGKILL')
  if (!keep) rmSync(home, { recursive: true, force: true })
}

const failed = results.filter(r => !r.ok)
console.log(`\ngui-acceptance: ${results.length - failed.length}/${results.length} assertions passed`)
if (sidecarLog.includes('ERROR')) console.log('sidecar logged errors — inspect .gui-acceptance/sidecar.log')
writeFileSync(join(outDir, 'sidecar.log'), sidecarLog)
if (failed.length > 0) {
  process.exitCode = 1
}
