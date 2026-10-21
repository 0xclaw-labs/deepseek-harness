import { describe, expect, it } from 'vitest'

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
