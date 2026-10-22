import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveDesktopUpdateSource } from '../src/update-source.ts'

const temporaryDirectories: string[] = []
afterEach(() => { for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-update-source-'))
  temporaryDirectories.push(directory)
  return directory
}

function sealedConfig(fields: Record<string, string>): string {
  return Object.entries(fields).map(([key, value]) => `${key}: ${value}`).join('\n') + '\n'
}

const BRAND_FEED = 'https://dl.modelxing.com/suishendazi-desk/feeds/mac-arm64/'

function resolve(text: string | undefined, channel: 'nightly' | 'latest' = 'nightly') {
  return resolveDesktopUpdateSource({
    packaged: true, configPath: '/app/resources/app-update.yml', expectedChannel: channel,
    readConfig: () => text,
  })
}

describe('desktop update source', () => {
  it('reports no feed outside a packaged application, even when a configuration exists', () => {
    expect(resolveDesktopUpdateSource({
      packaged: false, configPath: '/app/resources/app-update.yml', expectedChannel: 'nightly',
      readConfig: () => sealedConfig({ provider: 'generic', url: BRAND_FEED, channel: 'nightly' }),
    })).toEqual({ kind: 'absent' })
  })

  it('reads a sealed configuration from disk and treats only ENOENT as absent', () => {
    const directory = temporaryDirectory()
    const configPath = join(directory, 'app-update.yml')
    const options = { packaged: true, configPath, expectedChannel: 'nightly' as const }
    expect(resolveDesktopUpdateSource(options)).toEqual({ kind: 'absent' })
    writeFileSync(configPath, sealedConfig({ provider: 'generic', url: BRAND_FEED, channel: 'nightly', updaterCacheDirName: 'suishendazi-updater' }))
    expect(resolveDesktopUpdateSource(options)).toEqual({ kind: 'configured', url: BRAND_FEED, channel: 'nightly' })
  })

  it('accepts one generic PaiNuo HTTPS feed and ignores unrelated updater keys', () => {
    expect(resolve(sealedConfig({
      provider: 'generic', url: BRAND_FEED, channel: 'nightly',
      updaterCacheDirName: 'suishendazi-updater', useMultipleRangeRequest: 'false',
    }))).toEqual({ kind: 'configured', url: BRAND_FEED, channel: 'nightly' })
    expect(resolve(sealedConfig({ provider: 'generic', url: `"${BRAND_FEED}"`, channel: 'latest' }), 'latest'))
      .toEqual({ kind: 'configured', url: BRAND_FEED, channel: 'latest' })
  })

  it.each([
    'https://download.deepseek.com/feeds/mac-arm64/',
    'https://download-test.deepseek.com/feeds/mac-arm64/',
    'https://dsh-otel-collector.deepseeksvc.com/feeds/mac-arm64/',
  ])('rejects the upstream feed host %s before any request', (url) => {
    expect(resolve(sealedConfig({ provider: 'generic', url, channel: 'nightly' })))
      .toEqual({ kind: 'rejected', reason: 'upstream-host' })
  })

  it('rejects a feed that is not an HTTPS path without credentials, query, or fragment', () => {
    const cases: readonly (readonly [string, string])[] = [
      ['http://dl.modelxing.com/feed/', 'url-insecure'],
      ['https://user:secret@dl.modelxing.com/feed/', 'url-malformed'],
      ['https://dl.modelxing.com/feed/?channel=nightly', 'url-malformed'],
      ['https://dl.modelxing.com/feed/#fragment', 'url-malformed'],
      ['https://dl.modelxing.com/feed', 'url-malformed'],
      ['not a url', 'url-malformed'],
    ]
    for (const [url, reason] of cases) {
      expect(resolve(sealedConfig({ provider: 'generic', url, channel: 'nightly' })), url)
        .toEqual({ kind: 'rejected', reason })
    }
  })

  it('rejects a non-generic provider, a malformed configuration, and a channel mismatch', () => {
    expect(resolve(sealedConfig({ provider: 'github', url: BRAND_FEED, channel: 'nightly' })))
      .toEqual({ kind: 'rejected', reason: 'provider-unsupported' })
    expect(resolve(sealedConfig({ url: BRAND_FEED, channel: 'nightly' })))
      .toEqual({ kind: 'rejected', reason: 'provider-unsupported' })
    expect(resolve(sealedConfig({ provider: 'generic', channel: 'nightly' })))
      .toEqual({ kind: 'rejected', reason: 'config-malformed' })
    expect(resolve('provider: generic\nurl: https://a.example.com/x/\nurl: https://b.example.com/x/\nchannel: nightly\n'))
      .toEqual({ kind: 'rejected', reason: 'config-malformed' })
    // An empty value is a missing field, never a default destination.
    expect(resolve('provider: generic\nurl:\nchannel: nightly\n')).toEqual({ kind: 'rejected', reason: 'config-malformed' })
    expect(resolve(sealedConfig({ provider: 'generic', url: BRAND_FEED, channel: 'latest' })))
      .toEqual({ kind: 'rejected', reason: 'channel-mismatch' })
  })

  it('rejects a configuration that exists but cannot be read', () => {
    expect(resolveDesktopUpdateSource({
      packaged: true, configPath: '/app/resources/app-update.yml', expectedChannel: 'nightly',
      readConfig: () => { throw new Error('EACCES') },
    })).toEqual({ kind: 'rejected', reason: 'config-unreadable' })
  })
})
