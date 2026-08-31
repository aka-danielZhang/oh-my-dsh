/** Free-mirror helpers for GitHub Release assets. YML stays on GitHub. */

const VERSIONED_DOWNLOAD = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/releases\/download\/([^/]+)\/(.+)$/

export function readProxyUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env.HTTPS_PROXY ?? env.https_proxy ?? env.HTTP_PROXY ?? env.http_proxy ?? env.ALL_PROXY ?? env.all_proxy
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  return trimmed === '' ? undefined : trimmed
}


export function parseScutilProxy(stdout: string): string | undefined {
  const map: Record<string, string> = {}
  for (const line of stdout.split(/\n/)) {
    const match = /^\s*(\w+)\s*:\s*(.+?)\s*$/.exec(line)
    if (match === null) continue
    map[match[1]] = match[2]
  }
  if (map.HTTPSEnable === '1' && map.HTTPSProxy && map.HTTPSPort) {
    return `http://${map.HTTPSProxy}:${map.HTTPSPort}`
  }
  if (map.HTTPEnable === '1' && map.HTTPProxy && map.HTTPPort) {
    return `http://${map.HTTPProxy}:${map.HTTPPort}`
  }
  if (map.SOCKSEnable === '1' && map.SOCKSProxy && map.SOCKSPort) {
    return `socks5h://${map.SOCKSProxy}:${map.SOCKSPort}`
  }
  return undefined
}

export function resolveDownloadProxy(env: NodeJS.ProcessEnv = process.env, systemProxy?: string): string | undefined {
  return readProxyUrl(env) ?? systemProxy
}
export function electronProxyRules(proxy: string): string {
  return proxy.replace(/^https:\/\//i, 'http://')
}

export function normalizeMirrorPrefix(mirror: string): string {
  return mirror.trim().replace(/\/+$/, '')
}

export function readUpdateMirror(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env.DSH_UPDATE_MIRROR
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  return trimmed === '' ? undefined : normalizeMirrorPrefix(trimmed)
}

/**
 * Rewrite only versioned `/releases/download/` assets.
 * Leaves `/releases/latest/download/latest-mac.yml` (and latest.yml) on GitHub
 * so sha512 in the feed cannot be swapped with the zip.
 */
export function rewriteGithubReleaseDownloadUrl(url: string, mirror: string | undefined): string | undefined {
  if (mirror === undefined || mirror === '') return undefined
  const match = VERSIONED_DOWNLOAD.exec(url)
  if (match === null) return undefined
  const prefix = normalizeMirrorPrefix(mirror)
  return `${prefix}/${url}`
}

/** Prefix any GitHub URL. Used for runtime tarball fallbacks, not updater yml. */
export function applyUpdateMirror(url: string, mirror: string | undefined): string {
  if (mirror === undefined || mirror === '') return url
  if (!url.startsWith('https://github.com/')) return url
  return `${normalizeMirrorPrefix(mirror)}/${url}`
}

export function withMirrorFallback(url: string, mirror: string | undefined): string[] {
  const mirrored = url.startsWith('https://github.com/') && url.includes('/releases/download/')
    ? rewriteGithubReleaseDownloadUrl(url, mirror)
    : (url.startsWith('https://github.com/') ? applyUpdateMirror(url, mirror) : undefined)
  if (mirrored === undefined || mirrored === url) return [url]
  return [mirrored, url]
}

export async function firstSuccessful<T>(
  urls: string[],
  run: (url: string) => Promise<T>,
): Promise<T> {
  const errors: string[] = []
  for (const url of urls) {
    try {
      return await run(url)
    } catch (error) {
      errors.push(`${url}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new Error(errors.join('; ') || 'no urls')
}
