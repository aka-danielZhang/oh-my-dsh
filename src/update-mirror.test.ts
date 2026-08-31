import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  applyUpdateMirror,
  electronProxyRules,
  firstSuccessful,
  parseScutilProxy,
  readProxyUrl,
  readUpdateMirror,
  resolveDownloadProxy,
  rewriteGithubReleaseDownloadUrl,
  withMirrorFallback,
} from './update-mirror.ts'

const zip = 'https://github.com/aka-danielZhang/oh-my-dsh/releases/download/v0.3.0-rc.4/Oh-My-DSH-0.3.0-rc.4-arm64.zip'
const yml = 'https://github.com/aka-danielZhang/oh-my-dsh/releases/latest/download/latest-mac.yml'
const mirror = 'https://ghfast.top'

describe('rewriteGithubReleaseDownloadUrl', () => {
  it('prefixes versioned GitHub download assets', () => {
    assert.equal(rewriteGithubReleaseDownloadUrl(zip, mirror), `${mirror}/${zip}`)
  })

  it('leaves latest-mac.yml on GitHub', () => {
    assert.equal(rewriteGithubReleaseDownloadUrl(yml, mirror), undefined)
  })

  it('ignores an empty mirror', () => {
    assert.equal(rewriteGithubReleaseDownloadUrl(zip, undefined), undefined)
    assert.equal(rewriteGithubReleaseDownloadUrl(zip, ''), undefined)
  })
})

describe('applyUpdateMirror', () => {
  it('prefixes any github.com URL', () => {
    assert.equal(applyUpdateMirror(yml, `${mirror}/`), `${mirror}/${yml}`)
  })
})

describe('withMirrorFallback', () => {
  it('tries the mirror first for versioned downloads', () => {
    assert.deepEqual(withMirrorFallback(zip, mirror), [`${mirror}/${zip}`, zip])
  })

  it('does not rewrite latest yml as a versioned download', () => {
    assert.deepEqual(withMirrorFallback(yml, mirror), [`${mirror}/${yml}`, yml])
  })
})

describe('proxy and mirror env', () => {
  it('reads HTTPS_PROXY before HTTP_PROXY', () => {
    assert.equal(readProxyUrl({ HTTPS_PROXY: 'http://127.0.0.1:7890', HTTP_PROXY: 'http://ignore' }), 'http://127.0.0.1:7890')
    assert.equal(electronProxyRules('https://127.0.0.1:7890'), 'http://127.0.0.1:7890')
  })

  it('parses macOS scutil HTTPS proxy', () => {
    const stdout = [
      'HTTPSEnable : 1',
      'HTTPSPort : 7890',
      'HTTPSProxy : 127.0.0.1',
      'HTTPEnable : 1',
      'HTTPPort : 8080',
      'HTTPProxy : 10.0.0.1',
    ].join('\n')
    assert.equal(parseScutilProxy(stdout), 'http://127.0.0.1:7890')
  })

  it('prefers env proxy over system proxy', () => {
    assert.equal(resolveDownloadProxy({ HTTPS_PROXY: 'http://127.0.0.1:7890' }, 'http://10.0.0.1:8080'), 'http://127.0.0.1:7890')
    assert.equal(resolveDownloadProxy({}, 'http://127.0.0.1:7890'), 'http://127.0.0.1:7890')
    assert.equal(resolveDownloadProxy({}), undefined)
  })

  it('reads DSH_UPDATE_MIRROR and trims slashes', () => {
    assert.equal(readUpdateMirror({ DSH_UPDATE_MIRROR: 'https://ghfast.top/' }), 'https://ghfast.top')
    assert.equal(readUpdateMirror({}), undefined)
  })
})

describe('firstSuccessful', () => {
  it('falls back after the first url fails', async () => {
    const seen: string[] = []
    const value = await firstSuccessful(['bad', 'good'], async (url) => {
      seen.push(url)
      if (url === 'bad') throw new Error('nope')
      return url
    })
    assert.equal(value, 'good')
    assert.deepEqual(seen, ['bad', 'good'])
  })
})
