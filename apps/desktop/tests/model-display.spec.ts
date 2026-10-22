import { describe, expect, it } from 'vitest'
import {
  BRAND_MODEL_DISPLAY_PREFIX,
  BRAND_PROVIDER_DISPLAY_NAME,
  displayModelName,
  displayProviderName,
} from '../src/model-display.ts'
import { BRAND_PROVIDER_ID } from '../src/brand-endpoints.ts'

describe('model display names', () => {
  it('names the branded proxy route and keeps every other route verbatim', () => {
    expect(displayProviderName(BRAND_PROVIDER_ID)).toBe(BRAND_PROVIDER_DISPLAY_NAME)
    expect(displayProviderName(BRAND_PROVIDER_ID, 'ignored catalog name')).toBe(BRAND_PROVIDER_DISPLAY_NAME)
    // An upstream route the branded composition disables keeps its own name: the
    // branded app must not claim to serve a model it does not route.
    expect(displayProviderName('deepseek-official', 'DeepSeek')).toBe('DeepSeek')
    expect(displayProviderName('acme-gateway')).toBe('acme-gateway')
    expect(displayProviderName('painuo-other', 'PaiNuo reseller')).toBe('PaiNuo reseller')
  })

  it('brands a wire model id without altering the id itself', () => {
    const id = 'deepseek-v4.1-flash-1017-local'
    expect(displayModelName(id)).toBe(`${BRAND_MODEL_DISPLAY_PREFIX}DeepSeek-V4.1-Flash-1017-Local`)
    // The id is only ever read: display rules return a label, never a route.
    expect(id).toBe('deepseek-v4.1-flash-1017-local')
  })

  it.each([
    ['deepseek-v4-pro', undefined, '派诺·DeepSeek-V4-Pro'],
    ['deepseek-v4-flash-ga-260731', undefined, '派诺·DeepSeek-V4-Flash-Ga-260731'],
    ['kimi-k2.5', undefined, '派诺·Kimi-K2.5'],
    ['qwen3.5-397b-a17b', undefined, '派诺·Qwen3.5-397b-A17b'],
    ['MiniMax-M2.5', undefined, '派诺·MiniMax-M2.5'],
    ['ZHIPU/GLM-5.3-Flash', undefined, '派诺·ZHIPU/GLM-5.3-Flash'],
    // Vendor-styled and numeric tokens are never re-cased into another product.
    ['GLM-5.3', undefined, '派诺·GLM-5.3'],
    ['glm-5.3', undefined, '派诺·GLM-5.3'],
    ['fun-asr-flash-8k-realtime', undefined, '派诺·Fun-Asr-Flash-8k-Realtime'],
  ])('renders %s as %s', (id, catalogName, expected) => {
    expect(displayModelName(id, catalogName)).toBe(expected)
  })

  it('keeps the catalog name when the catalog advertises one, and brands it', () => {
    expect(displayModelName('deepseek-flash', 'DeepSeek-V4.1-Flash'))
      .toBe(`${BRAND_MODEL_DISPLAY_PREFIX}DeepSeek-V4.1-Flash`)
    // A catalog name that is already branded, and a name that is not a wire id
    // at all, both survive a second pass unchanged.
    expect(displayModelName('deepseek-flash', '派诺·DeepSeek-V4.1-Flash')).toBe('派诺·DeepSeek-V4.1-Flash')
    expect(displayModelName('brand-new-model', '  Acme Turbo  ')).toBe('派诺·Acme Turbo')
  })

  it('returns an unknown or empty name untouched instead of inventing one', () => {
    expect(displayModelName('')).toBe('')
    expect(displayModelName('   ')).toBe('')
    expect(displayModelName('gpt-5.4-mini', '')).toBe('派诺·Gpt-5.4-Mini')
    expect(displayModelName('', 'Only A Catalog Name')).toBe('派诺·Only A Catalog Name')
  })

  it('is rule-driven, not a fixed model list', () => {
    // A model that does not exist today still gets a branded, readable label.
    expect(displayModelName('deepseek-v9-ultra-2099')).toBe('派诺·DeepSeek-V9-Ultra-2099')
    expect(displayModelName('vendor-x/future-model-v2')).toBe('派诺·Vendor-X/future-Model-V2')
  })
})
