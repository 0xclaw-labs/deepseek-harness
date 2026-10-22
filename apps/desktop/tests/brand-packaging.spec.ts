import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { initProfile } from '@deepseek-ai/dsh-app-boot'
import {
  applyBrandDefaults,
  BRAND_DEFAULTS_BEGIN,
  BRAND_DEFAULTS_END,
  brandDefaultsBlock,
  brandWorkspaceBlock,
  composeBrandDefaults,
} from '../src/brand-defaults.ts'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const UNSIGNED_MAC = {
  DSH_DESKTOP_APP_ID: 'cc.example.app',
  DSH_DESKTOP_UNSIGNED: '1',
  DSH_DESKTOP_TARGET_PLATFORM: 'darwin',
  DSH_DESKTOP_TARGET_ARCH: 'arm64',
}

describe('branded packaging identity', () => {
  it('keeps upstream protocol metadata when no brand environment is supplied', async () => {
    const { createElectronBuilderConfig } = await import('../scripts/electron-builder-config.mjs')
    const config = createElectronBuilderConfig(UNSIGNED_MAC, 'darwin', 'arm64')
    expect(config.protocols).toEqual([{ name: 'DeepSeek Harness', schemes: ['dsh'] }])
    expect(config.extraMetadata).toMatchObject({ dshDesktopProtocolScheme: 'dsh' })
    expect(config.extraMetadata).not.toHaveProperty('productName')
    expect(config.extraMetadata).not.toHaveProperty('dshDesktopProfileDirectory')
  })

  it('writes the declared scheme into the manifest used by runtime registration', async () => {
    const { createElectronBuilderConfig } = await import('../scripts/electron-builder-config.mjs')
    const config = createElectronBuilderConfig({
      ...UNSIGNED_MAC,
      DSH_DESKTOP_PRODUCT_NAME: '随身搭子',
      DSH_DESKTOP_PROTOCOL_SCHEME: 'suishendazi',
      DSH_DESKTOP_ARTIFACT_PREFIX: 'suishendazi-harness',
    }, 'darwin', 'arm64')
    expect(config.protocols).toEqual([{ name: '随身搭子', schemes: ['suishendazi'] }])
    expect(config.extraMetadata).toMatchObject({
      dshDesktopProtocolScheme: 'suishendazi',
      productName: '随身搭子',
      dshDesktopProfileDirectory: 'cc.example.app',
    })
  })
})

describe('branded profile defaults', () => {
  it('routes the default model to the branded provider instead of the public DeepSeek API', () => {
    const block = brandDefaultsBlock()
    expect(block).toContain('provider: painuo')
    expect(block).toContain('model: deepseek-v4.1-flash-1017-local')
    expect(block).not.toContain('deepseek-official')
  })

  it('does not pin upstream web search or ship upstream telemetry endpoints', () => {
    const block = brandDefaultsBlock()
    expect(block).not.toContain('searchProvider: deepseek-official')
    expect(block).not.toContain('deepseek-harness-desktop')
    expect(block).not.toContain('dsh-otel-collector.deepseeksvc.com')
    expect(block).toContain('- id: desktop-product-telemetry\n  disabled: true')
    expect(block).toContain('- id: product-analytics\n  disabled: true')
  })

  it('replaces the empty upstream patch and stays idempotent', () => {
    const first = composeBrandDefaults('[]\n')
    expect(first.startsWith(BRAND_DEFAULTS_BEGIN)).toBe(true)
    expect(first).not.toContain('[]')
    expect(first.match(/brand-defaults: begin/gu)).toHaveLength(1)
    expect(first.match(/brand-defaults: end/gu)).toHaveLength(1)
    expect(composeBrandDefaults(first)).toBe(first)
  })

  it('preserves user rows after the generated block', () => {
    const userRow = '- id: agent-default-model\n  config:\n    provider: custom\n    model: chosen\n'
    const next = composeBrandDefaults(`${brandDefaultsBlock()}${userRow}`)
    expect(next.match(/brand-defaults: begin/gu)).toHaveLength(1)
    expect(next).toContain(userRow)
    expect(next.indexOf(BRAND_DEFAULTS_BEGIN)).toBeLessThan(next.indexOf('- id: agent-default-model'))
    expect(next.lastIndexOf('- id: agent-default-model')).toBeGreaterThan(next.indexOf(BRAND_DEFAULTS_END))
  })

  it('leaves an unterminated hand-edited block alone instead of swallowing later rows', () => {
    const existing = `${BRAND_DEFAULTS_BEGIN} - hand edited\n- id: user-row\n`
    expect(composeBrandDefaults(existing)).toBe(existing)
  })

  it('keeps the branded first-use Workspace row in the same generated patch', () => {
    const workspace = brandWorkspaceBlock('/Users/a/Documents/随身搭子/default-workspace')
    expect(workspace).toContain('- id: workspace-controller')
    expect(workspace).toContain('defaultWorkspacePath: "/Users/a/Documents/随身搭子/default-workspace"')
    expect(workspace).not.toContain('defaultWorkspacePath: "/Users/a/Documents/deepseek-harness/default-workspace"')
  })

  it('writes the generated patch into a freshly initialized desktop profile', () => {
    const home = mkdtempSync(join(tmpdir(), 'sdz-brand-profile-'))
    tempDirs.push(home)
    const profile = join(home, 'profiles', 'desktop')
    initProfile(profile, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
    const patch = join(profile, 'cordis.patch.yml')
    expect(applyBrandDefaults(patch)).toBe(true)
    const content = readFileSync(patch, 'utf8')
    expect(content).toContain('provider: painuo')
    expect(content).not.toContain('deepseek-official')
    expect(applyBrandDefaults(patch)).toBe(false)
    expect(readFileSync(patch, 'utf8')).toBe(content)
    const manifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8')) as {
      name?: string
      dsh?: { profile?: { bundles?: string[] } }
    }
    expect(manifest.name).toBe('dsh-profile-desktop')
    expect(manifest.dsh?.profile?.bundles).toEqual(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
  })
})
