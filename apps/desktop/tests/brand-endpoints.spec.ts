import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import {
  assertBrandEndpoint,
  assertNoUpstreamEndpointOverrides,
  BRAND_AUTH_ORIGIN,
  BRAND_CLOUD_DESKTOP_API_ORIGIN,
  BRAND_DEFAULT_MODEL_ID,
  BRAND_INFERENCE_BASE_URL,
  BRAND_MODEL_CATALOG_URL,
  BRAND_PROVIDER_ID,
  chooseDefaultModel,
  isUpstreamDeepSeekHost,
  isUpstreamDeepSeekUrl,
  paiNuoProviderPatch,
  readPaiNuoGrant,
} from '../src/brand-endpoints.ts'
import { BRAND_PROVIDER_DISPLAY_NAME } from '../src/model-display.ts'

const brand = JSON.parse(readFileSync(fileURLToPath(new URL('../../../custom/branding/brand.json', import.meta.url)), 'utf8')) as {
  endpoints: {
    authOrigin: string
    inferenceBaseUrl: string
    modelCatalogUrl: string
    updateFeed: null
    pluginMarketIndexes: []
    webSearch: null
    telemetry: null
    billingCenterUrl: string
    cloudDesktopApiOrigin: string
  }
}

describe('brand endpoints', () => {
  it('pins the runtime constants to the reviewed brand manifest', () => {
    expect(brand.endpoints).toMatchObject({
      authOrigin: BRAND_AUTH_ORIGIN,
      inferenceBaseUrl: BRAND_INFERENCE_BASE_URL,
      modelCatalogUrl: BRAND_MODEL_CATALOG_URL,
      updateFeed: null,
      pluginMarketIndexes: [],
      webSearch: null,
      telemetry: null,
      cloudDesktopApiOrigin: BRAND_CLOUD_DESKTOP_API_ORIGIN,
    })
    // The delegate and noVNC surfaces are gateway paths on the billing origin;
    // a second host would need its own nginx/TLS surface and its own review.
    expect(new URL(BRAND_CLOUD_DESKTOP_API_ORIGIN).origin).toBe(new URL(brand.endpoints.billingCenterUrl).origin)
  })

  it.each([
    'platform.deepseek.com', 'api.deepseek.com', 'download.deepseek.com',
    'download-test.deepseek.com', 'dsh-otel-collector.deepseeksvc.com', 'deepseek.com',
  ])('recognizes upstream service host %s', (host) => {
    expect(isUpstreamDeepSeekHost(host)).toBe(true)
  })

  it.each(['auth.modelxing.com', 'modelxing.com', '127.0.0.1', 'example.com', 'deepseek.example.com'])(
    'does not classify %s as an upstream service',
    (host) => { expect(isUpstreamDeepSeekHost(host)).toBe(false) },
  )

  it('rejects upstream endpoints while accepting the PaiNuo account and proxy', () => {
    expect(() => assertBrandEndpoint('https://platform.deepseek.com', 'DSH_PLATFORM_ORIGIN'))
      .toThrow(/must not point at an upstream DeepSeek service/u)
    expect(() => assertBrandEndpoint('https://download.deepseek.com/feed', 'update feed'))
      .toThrow(/must not point at an upstream DeepSeek service/u)
    expect(assertBrandEndpoint(BRAND_AUTH_ORIGIN, 'auth').origin).toBe(BRAND_AUTH_ORIGIN)
    expect(assertBrandEndpoint(BRAND_INFERENCE_BASE_URL, 'inference').origin).toBe(BRAND_AUTH_ORIGIN)
    expect(isUpstreamDeepSeekUrl(BRAND_MODEL_CATALOG_URL)).toBe(false)
  })

  it('fails startup when the launching environment redirects a brand endpoint upstream', () => {
    for (const name of ['DSH_PLATFORM_ORIGIN', 'DSH_INFERENCE_ORIGIN', 'DEEPSEEK_BASE_URL',
      'DSH_TELEMETRY_OTLP_URL', 'DSH_PRODUCT_ANALYTICS_OTLP_URL', 'DSH_DESKTOP_UPDATE_ORIGIN', 'DOWNLOAD_TEST_ORIGIN']) {
      expect(() => assertNoUpstreamEndpointOverrides({ [name]: 'https://api.deepseek.com/v1' }), name)
        .toThrow(new RegExp(`${name} must not point at an upstream DeepSeek service`, 'u'))
    }
    expect(() => assertNoUpstreamEndpointOverrides({
      DSH_PLATFORM_ORIGIN: BRAND_AUTH_ORIGIN,
      DSH_INFERENCE_ORIGIN: BRAND_AUTH_ORIGIN,
      DEEPSEEK_BASE_URL: '',
    })).not.toThrow()
  })

  it('forwards only a brand-issued opaque grant, never an upstream account token', () => {
    const valid = 'deepseek-account-platform/default:\n  kind: grant\n  payload:\n    token: sdzdsh_fixture\n    issuer: https://auth.modelxing.com\n'
    expect(readPaiNuoGrant(valid)).toBe('sdzdsh_fixture')
    expect(readPaiNuoGrant(valid.replace('https://auth.modelxing.com', 'https://platform.deepseek.com'))).toBeUndefined()
    expect(readPaiNuoGrant(valid.replace('sdzdsh_fixture', 'upstream_token'))).toBeUndefined()
    expect(readPaiNuoGrant('unrelated: true\n')).toBeUndefined()
  })

  it('generates a parseable PaiNuo provider patch with a brand default model', () => {
    const patch = paiNuoProviderPatch([
      { id: BRAND_DEFAULT_MODEL_ID, name: BRAND_DEFAULT_MODEL_ID },
      { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
    ])
    expect(patch).toContain(`baseURL: ${BRAND_INFERENCE_BASE_URL}`)
    expect(patch).toContain(`provider: ${BRAND_PROVIDER_ID}`)
    expect(patch).toContain(`model: "${BRAND_DEFAULT_MODEL_ID}"`)
    expect(patch).not.toMatch(/deepseek\.com|deepseeksvc\.com/u)
    // The Models page and the model selector render this catalog name; every
    // wire id stays the provider's own, so a request still names the same model.
    expect(patch).toContain(`displayName: ${BRAND_PROVIDER_DISPLAY_NAME}`)
    const parsed = yaml.load(patch, { schema: entryListSchema })
    expect(parsed).toEqual([
      expect.objectContaining({
        id: 'llm-pi-ai',
        config: {
          providers: {
            [BRAND_PROVIDER_ID]: expect.objectContaining({
              displayName: BRAND_PROVIDER_DISPLAY_NAME,
              models: [
                { id: BRAND_DEFAULT_MODEL_ID, name: '派诺·DeepSeek-V4.1-Flash-1017-Local' },
                { id: 'deepseek-v4-pro', name: '派诺·DeepSeek-V4-Pro' },
              ],
            }),
          },
        },
      }),
      expect.objectContaining({ id: 'agent-default-model', config: { provider: BRAND_PROVIDER_ID, model: BRAND_DEFAULT_MODEL_ID } }),
    ])
  })

  it('produces no provider patch from an empty catalog, keeping the route fail-closed', () => {
    expect(paiNuoProviderPatch([])).toBe('')
    expect(chooseDefaultModel([])).toBeUndefined()
    expect(chooseDefaultModel([{ id: 'other', name: 'other' }])).toBe('other')
    expect(chooseDefaultModel([{ id: 'other', name: 'other' }, { id: BRAND_DEFAULT_MODEL_ID, name: 'flash' }]))
      .toBe(BRAND_DEFAULT_MODEL_ID)
  })
})
