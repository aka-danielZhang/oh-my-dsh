import fs from 'node:fs'
import path from 'node:path'

import { alertDialog, choose } from './dialog.ts'
import { frozenProfileInstallOnce, runDesktopPluginInstall, validateProfileConfig } from './install.ts'
import { dshHome, shellRoot } from './paths.ts'
import { ensurePluginRuntimeLinks, findDesktopPlugins, shippedPluginRefs } from './plugins.ts'
import {
  type AdoptionRecord,
  backupDetails,
  beginRestore,
  cleanupStaleBackupStaging,
  createBackup,
  currentProfileMatchesBackup,
  inspectHome,
  latestRecord,
  pruneOtherBackups,
  restartWithConsent,
  startRecord,
  transition,
  verifyBackup,
  type ExistingHomeSummary,
} from './profile-adoption.ts'
import {
  isExpectationMismatch,
  mutateWebProfileExpected,
  profileSnapshotIdentity,
  recoverWebProfile,
  replaceProfileFromSnapshot,
  webProfileIdentity,
  type ProfileExpectation,
} from './profile-repair.ts'
import { findRuntime, type Runtime } from './runtime.ts'
import {
  currentSidecarExit,
  freePort,
  initSidecarRegistry,
  killSidecar,
  spawnSidecar,
  waitReady,
} from './sidecar.ts'
import {
  DEFAULT_SURFACE,
  loadActiveSurface,
  saveActiveSurface,
  validateSurfaceDir,
} from './surface.ts'
import { configureSurfaceSwitch } from './surface-switch.ts'
import { openMainWindow } from './window.ts'
import { MISSING_RESTORE_SOURCE } from './constants.ts'

import { planProfileAdoption } from './adoption-plan.ts'

export type BootOutcome = 'started' | 'exitRequested'

function currentRestoreSource(canonicalHome: string): string {
  return webProfileIdentity(canonicalHome) ?? MISSING_RESTORE_SOURCE
}

function refreshAdoptionBackupIfNeeded(
  root: string,
  canonicalHome: string,
  adoption: AdoptionRecord,
): { ok: true; adoption: AdoptionRecord } | { ok: false; adoption: AdoptionRecord } {
  if (adoption.backup === null) return { ok: true, adoption }
  const current = webProfileIdentity(canonicalHome)
  if (current === adoption.backup.sourceIdentity) return { ok: true, adoption }
  if (current === null) {
    const next = transition(root, adoption, 'consentRequired', null)
    alertDialog(
      'Web Profile 已被删除',
      '当前 Web Profile 已在备份后被删除，因此无法保存它的新状态。Desktop 没有新建或覆盖 Profile，旧备份文件也仍保留。\n\nDesktop 现在将退出；下次启动会按当前状态重新征求授权。',
    )
    return { ok: false, adoption: next }
  }
  const backup = createBackup(root, canonicalHome)
  return { ok: true, adoption: transition(root, adoption, 'adopting', backup) }
}

function restoreAdoptionBackup(
  runtime: Runtime,
  home: string,
  root: string,
  canonicalHome: string,
  adoption: AdoptionRecord,
): AdoptionRecord {
  if (adoption.backup === null) throw new Error('no pre-adoption Web Profile backup is available')
  const backup = adoption.backup
  verifyBackup(root, canonicalHome, backup)
  if (!currentProfileMatchesBackup(canonicalHome, backup)) {
    const expected = adoption.restoreSourceIdentity
    if (expected === null) throw new Error('pending profile restore has no source identity')
    const expectation: ProfileExpectation = webProfileIdentity(canonicalHome) === null
      ? 'missing'
      : { identity: expected }
    mutateWebProfileExpected(home, [], expectation, (shadowHome) => {
      const profile = path.join(shadowHome, 'profiles/web')
      replaceProfileFromSnapshot(backup.profile, profile)
      if (!fs.existsSync(path.join(profile, 'pnpm-lock.yaml'))) {
        throw new Error('profile backup has no pnpm-lock.yaml for a frozen restore')
      }
      frozenProfileInstallOnce(runtime, shadowHome, root, 'web')
      if (profileSnapshotIdentity(profile) !== backup.snapshotIdentity) {
        throw new Error('frozen restore changed the backed-up Web Profile configuration')
      }
      validateProfileConfig(runtime, shadowHome, root, 'web')
    })
  }
  if (!currentProfileMatchesBackup(canonicalHome, backup)) {
    throw new Error('restored Web Profile does not match the approved backup')
  }
  const restored = transition(root, adoption, 'restored', backup)
  alertDialog(
    'Web Profile 已恢复',
    `已恢复到你确认共享 DSH_HOME 时保存的 Web Profile 配置。\n\n备份：${backupDetails(backup)}\n\nDesktop 现在将退出；下次启动会重新征求共享 DSH_HOME 的授权。`,
  )
  return restored
}

function prepareProfileAdoption(root: string, summary: ExistingHomeSummary, packaged: boolean): AdoptionRecord | undefined {
  cleanupStaleBackupStaging(root, summary.canonicalHome)
  let previous = latestRecord(root, summary.canonicalHome)
  if (previous?.backup) {
    try {
      verifyBackup(root, summary.canonicalHome, previous.backup)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      for (;;) {
        const action = choose({
          title: 'Web Profile 备份校验失败',
          message: `Desktop 不会静默使用或删除这份备份。\n\n原因：${message}\n\n你可以保留当前 Web Profile 并撤销旧恢复点，查看备份位置，或退出。`,
          primary: '保留当前 Profile',
          secondary: '查看备份位置',
          escape: '退出',
        })
        if (action === 'primary') {
          transition(root, previous, 'consentRequired', null)
          alertDialog(
            '已保留当前 Web Profile',
            '旧恢复点已从 Desktop 的活动状态中移除；若此前正在恢复，该恢复请求也已撤销。磁盘上的备份文件没有被删除。Desktop 现在将退出；下次启动会重新征求授权并创建新备份。',
          )
          return undefined
        }
        if (action === 'secondary') {
          alertDialog('备份位置', `${previous.backup.root}\n\n校验错误：${message}`)
          continue
        }
        return undefined
      }
    }
  }

  switch (planProfileAdoption(summary.hasExistingData, previous?.status)) {
    case 'resume':
      if (previous === null) throw new Error('resume plan without an adoption record')
      return previous
    case 'startFresh':
      return startRecord(root, summary.canonicalHome, 'freshHome', false, null)
    case 'askExisting':
      break
  }

  for (;;) {
    const backupNote = summary.hasWebProfile
      ? '继续前会保存一份可恢复的当前 Web Profile 配置快照。'
      : '当前没有 Web Profile，因此没有需要备份的 Profile；Desktop 会新建它。'
    const primary = summary.hasWebProfile ? '备份并继续' : '继续'
    const shipped = shippedPluginRefs(packaged).map((spec) => spec.package)
    const shippedLabel = shipped.length <= 1
      ? (shipped[0] ?? '')
      : `${shipped.slice(0, -1).join('、')}和${shipped[shipped.length - 1] ?? ''}`
    const message = `检测到现有 DSH 数据目录：${summary.canonicalHome}\n\n其中有 ${String(summary.plugins.length)} 个 Web Profile 插件、${String(summary.agentPresetCount)} 个 Agent 预设。Desktop 与终端 DSH 将共享该目录。\n\n继续后只会更新 Web Profile，添加或刷新 ${shippedLabel}。现有会话、凭据、设置、Agent 预设、其他 Profile 与其他插件都会保留。${backupNote}`
    const action = choose({
      title: '使用现有的 DSH 数据？',
      message,
      primary,
      secondary: '查看变更',
      escape: '退出',
    })
    if (action === 'primary') {
      let backup = null
      if (summary.hasWebProfile) {
        try {
          backup = createBackup(root, summary.canonicalHome)
        } catch (error) {
          if (webProfileIdentity(summary.canonicalHome) === null) {
            alertDialog(
              'Web Profile 已发生变化',
              '等待确认期间，当前 Web Profile 已被删除，因此 Desktop 无法兑现刚才说明的备份步骤，也没有修改共享 Home。\n\nDesktop 现在将退出；下次启动会按最新状态重新判断并征求授权。',
            )
            return undefined
          }
          throw error
        }
      }
      if (previous !== null) return restartWithConsent(root, previous, backup)
      return startRecord(root, summary.canonicalHome, 'existingHome', true, backup)
    }
    if (action === 'secondary') {
      const plugins = summary.plugins.length === 0
        ? '（当前 Web Profile 没有声明插件）'
        : summary.plugins.join('\n- ')
      alertDialog(
        'Desktop 将修改的范围',
        `DSH_HOME：${summary.canonicalHome}\nWeb Profile：${summary.canonicalHome}/profiles/web\n\n现有插件：\n- ${plugins}\n\nDesktop 只更新这个 Web Profile 的 package manifest、lockfile 与 node_modules，并新增或刷新 desktop-owned 包。\n\n不会修改 sessions、credentials、settings、.agent-presets、home cordis.patch.yml 或其他 profiles。`,
      )
      continue
    }
    return undefined
  }
}

function installWithProfileRepair(
  runtime: Runtime,
  plugins: ReturnType<typeof findDesktopPlugins>,
  home: string,
  root: string,
  canonicalHome: string,
  adoption: AdoptionRecord,
): { outcome: BootOutcome; adoption: AdoptionRecord } {
  let current = adoption
  let automatedInstallRetries = 0
  for (;;) {
    try {
      if (current.status === 'restorePending') {
        current = restoreAdoptionBackup(runtime, home, root, canonicalHome, current)
        return { outcome: 'exitRequested', adoption: current }
      }
      const expectation: ProfileExpectation = current.status === 'adopting'
        ? current.backup === null
          ? 'missing'
          : { identity: current.backup.sourceIdentity }
        : 'unchecked'
      runDesktopPluginInstall(runtime, plugins, home, root, 'web', expectation)
      if (current.status === 'adopting') {
        current = transition(root, current, 'active', current.backup)
        if (current.backup !== null) {
          try {
            pruneOtherBackups(root, canonicalHome, current.backup)
          } catch (error) {
            console.error(`dsh-desktop: prune old profile backups failed: ${String(error)}`)
          }
        }
      }
      return { outcome: 'started', adoption: current }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const pendingRestore = current.status === 'restorePending'
      const mismatch = isExpectationMismatch(message)
      if (mismatch && current.status === 'adopting' && current.backup === null) {
        current = transition(root, current, 'consentRequired', null)
        alertDialog(
          '检测到新的 Web Profile',
          '在 Desktop 检查到空 Home 之后，终端创建或修改了 Web Profile。Desktop 没有修改它，也不会把之前的空 Home 判断当作授权。\n\nDesktop 现在将退出；下次启动会重新确认共享范围并先保存这个新 Profile。',
        )
        return { outcome: 'exitRequested', adoption: current }
      }
      if (mismatch && !pendingRestore && current.backup !== null) {
        const action = choose({
          title: 'Web Profile 已发生变化',
          message: '备份之后，Web Profile 又发生了变化；这也可能表示上一次 Desktop 事务已提交、但状态尚未收尾。Desktop 尚未执行新的覆盖。\n\n你可以先保存当前状态再继续，恢复已保存备份，或退出。',
          primary: '保存当前状态并继续',
          secondary: '恢复已保存备份',
          escape: '退出',
        })
        if (action === 'primary') {
          const refreshed = refreshAdoptionBackupIfNeeded(root, canonicalHome, current)
          current = refreshed.adoption
          if (!refreshed.ok) return { outcome: 'exitRequested', adoption: current }
          continue
        }
        if (action === 'secondary') {
          current = beginRestore(root, current, currentRestoreSource(canonicalHome))
          continue
        }
        return { outcome: 'exitRequested', adoption: current }
      }
      if (mismatch && pendingRestore) {
        const action = choose({
          title: '终端已修改 Web Profile',
          message: '恢复请求之后，终端又修改了 Web Profile。Desktop 已停止恢复，不会用旧备份覆盖这些新修改。\n\n你可以保留当前 Profile 并撤销这次恢复请求，或直接退出。',
          primary: '保留当前 Profile',
          escape: '退出',
        })
        if (action === 'primary') {
          current = transition(root, current, 'restoreAbandoned', current.backup)
          alertDialog(
            '已保留当前 Web Profile',
            '这次恢复请求已撤销。Desktop 现在将退出；下次启动会重新征求共享 DSH_HOME 的授权。',
          )
        }
        return { outcome: 'exitRequested', adoption: current }
      }
      const canRestore = !pendingRestore && current.backup !== null
      const secondary = pendingRestore
        ? '保留当前 Profile'
        : canRestore
          ? '恢复已保存备份'
          : undefined
      const action = choose({
        title: pendingRestore ? 'Web Profile 恢复未完成' : 'Web Profile 更新未完成',
        message: `Desktop 尚未启动 sidecar，真实 Web Profile 没有被部分覆盖。\n\n原因：${message}\n\n安装日志：${root}/logs/install.log\n\n你可以重试${pendingRestore ? '、保留当前 Profile 并撤销恢复' : canRestore ? '、恢复已保存备份' : ''}，或者退出后继续使用终端 DSH。`,
        primary: '重试',
        ...(secondary === undefined ? {} : { secondary }),
        escape: '退出',
      })
      if (action === 'primary') {
        // DSH_DESKTOP_DIALOG_DEFAULT=primary would otherwise retry forever.
        if (process.env.DSH_DESKTOP_DIALOG_DEFAULT === 'primary') {
          automatedInstallRetries += 1
          if (automatedInstallRetries >= 2) {
            console.error(`dsh-desktop: giving up after ${String(automatedInstallRetries)} automated install retries: ${message}`)
            return { outcome: 'exitRequested', adoption: current }
          }
        }
        continue
      }
      if (action === 'secondary' && pendingRestore) {
        current = transition(root, current, 'restoreAbandoned', current.backup)
        alertDialog(
          '已保留当前 Web Profile',
          '这次恢复请求已撤销。Desktop 现在将退出；下次启动会重新征求共享 DSH_HOME 的授权。',
        )
        return { outcome: 'exitRequested', adoption: current }
      }
      if (action === 'secondary' && canRestore) {
        current = beginRestore(root, current, currentRestoreSource(canonicalHome))
        continue
      }
      return { outcome: 'exitRequested', adoption: current }
    }
  }
}

export async function bootSequence(packaged: boolean, electronPath: string): Promise<BootOutcome> {
  const root = shellRoot()
  const home = dshHome()
  recoverWebProfile(home)
  const summary = inspectHome(home)
  const adoption = prepareProfileAdoption(root, summary, packaged)
  if (adoption === undefined) return 'exitRequested'

  const runtime = findRuntime(packaged, electronPath)
  const plugins = findDesktopPlugins(packaged)
  initSidecarRegistry()
  const installed = installWithProfileRepair(
    runtime,
    plugins,
    home,
    root,
    summary.canonicalHome,
    adoption,
  )
  if (installed.outcome === 'exitRequested') return 'exitRequested'
  ensurePluginRuntimeLinks(plugins, runtime)

  // The active surface defaults to web; a switched surface must still pass
  // validation at boot (a terminal edit could have broken or deleted it), and
  // gets the same desktop-package transaction before it boots. Any failure
  // falls back to web with the state reset, never a dead window.
  let surface = loadActiveSurface(root, home)
  if (surface !== DEFAULT_SURFACE) {
    const verdict = validateSurfaceDir(home, path.join(home, 'profiles', surface))
    if (!verdict.ok) {
      alertDialog(
        '运行面已失效',
        `上次使用的运行面「${surface}」已不可用：\n\n${verdict.reason}\n\n本次启动回退到默认运行面「${DEFAULT_SURFACE}」。`,
      )
      saveActiveSurface(root, home, DEFAULT_SURFACE)
      surface = DEFAULT_SURFACE
    }
  }
  if (surface !== DEFAULT_SURFACE) {
    try {
      runDesktopPluginInstall(runtime, plugins, home, root, surface, 'unchecked')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      alertDialog(
        '运行面准备失败',
        `无法为运行面「${surface}」准备桌面组件，本次启动回退到「${DEFAULT_SURFACE}」。\n\n${message}\n\n安装日志：${root}/logs/install.log`,
      )
      saveActiveSurface(root, home, DEFAULT_SURFACE)
      surface = DEFAULT_SURFACE
    }
  }
  configureSurfaceSwitch({ runtime, plugins, home, root })

  const port = await freePort()
  const sidecarLog = spawnSidecar(runtime, home, port, surface)
  const launchUrl = await waitReady(port)
  if (launchUrl === undefined) {
    const exitInfo = currentSidecarExit()
    killSidecar()
    throw new Error(
      exitInfo !== null
        ? `harness sidecar for profile ${surface} exited before printing a dsh web launch URL (${exitInfo}; see ${sidecarLog})`
        : `harness server on 127.0.0.1:${String(port)} did not print a dsh web launch URL within 120s (see ${sidecarLog})`,
    )
  }
  const e2e = process.env.DSH_DESKTOP_E2E_PROBE === '1'
  await openMainWindow(launchUrl, e2e)
  return 'started'
}
