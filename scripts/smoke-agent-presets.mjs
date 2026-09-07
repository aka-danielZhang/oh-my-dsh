/** Exercise shipped presets through the installed CLI without sending a model request. */
import { spawn, execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const runtime = JSON.parse(process.argv[2])
const patch = join(process.env.DSH_HOME, 'preset-smoke.patch.json')
writeFileSync(patch, JSON.stringify([{ insert: [{
  id: 'desktop-preset-smoke',
  name: fileURLToPath(new URL('./fixtures/agent-preset-probe.mjs', import.meta.url)),
}] }]))
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|SECRET|TOKEN|PASSWORD/.test(key)))
env.DSH_TELEMETRY_DISABLED = '1'
env.DSH_HOME = process.env.DSH_HOME
for (let attempt = 1; attempt <= 2; attempt++) {
  await check(attempt)
}

async function check(attempt) {
  const child = spawn(runtime.node, [...runtime.argsPrefix, runtime.cli, '--profile', 'web', '--patch', patch,
    '--port', '0', '--no-open'], {
    cwd: runtime.cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32',
  })
  let result
  let output = ''
  let lineBuffer = ''
  let timedOut = false
  let killTimer
  const stop = () => {
    if (child.exitCode !== null || child.signalCode !== null) return
    child.kill('SIGTERM')
    killTimer ??= setTimeout(() => {
      if (child.exitCode !== null || child.signalCode !== null) return
      try {
        if (process.platform === 'win32') {
          execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
        } else {
          process.kill(-child.pid, 'SIGKILL')
        }
      } catch (error) {
        if (error.code !== 'ESRCH') output += `\nForced cleanup failed: ${error.message}`
      }
    }, 10_000)
  }
  const timer = setTimeout(() => { timedOut = true; stop() }, 120_000)
  child.stdout.on('data', chunk => {
    output = (output + chunk).slice(-200_000)
    lineBuffer += chunk
    let end
    while ((end = lineBuffer.indexOf('\n')) !== -1) {
      const line = lineBuffer.slice(0, end)
      lineBuffer = lineBuffer.slice(end + 1)
      if (line.startsWith('DSH_PRESET_SMOKE_RESULT ')) {
        try { result = JSON.parse(line.slice('DSH_PRESET_SMOKE_RESULT '.length)) }
        catch (error) { result = { error: String(error) } }
      }
    }
  })
  child.stderr.on('data', chunk => { output = (output + chunk).slice(-200_000) })
  try {
    const [code, signal] = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => resolve([code, signal]))
    })
    if (timedOut || !result || result.error || code !== 0 || signal !== null) {
      throw new Error(`preset smoke failed (boot ${attempt}, timeout=${timedOut}, code=${code}, signal=${signal}): ${result?.error ?? output}`)
    }
    console.log(`preset smoke boot ${attempt}: ${JSON.stringify(result.presets)}`)
  } finally {
    clearTimeout(timer)
    clearTimeout(killTimer)
  }
}
