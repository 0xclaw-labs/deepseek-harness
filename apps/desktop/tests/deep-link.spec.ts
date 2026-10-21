import { describe, expect, it } from 'vitest'
import { LEGACY_DEEP_LINK_SCHEME, parseDeepLink, resolveDeepLinkScheme } from '../src/deep-link.ts'

describe('deep-link schemes', () => {
  it('normalizes a declared scheme and falls back for absent or malformed values', () => {
    expect(resolveDeepLinkScheme(' SUISHENDAZI ')).toBe('suishendazi')
    expect(resolveDeepLinkScheme('dsh')).toBe(LEGACY_DEEP_LINK_SCHEME)
    expect(resolveDeepLinkScheme(undefined)).toBe(LEGACY_DEEP_LINK_SCHEME)
    expect(resolveDeepLinkScheme('')).toBe(LEGACY_DEEP_LINK_SCHEME)
    expect(resolveDeepLinkScheme('not a scheme')).toBe(LEGACY_DEEP_LINK_SCHEME)
    expect(resolveDeepLinkScheme('1dsh')).toBe(LEGACY_DEEP_LINK_SCHEME)
    expect(resolveDeepLinkScheme(undefined, 'suishendazi')).toBe('suishendazi')
  })
})

describe('open-url classification', () => {
  it('focuses the app for the bundle scheme, including a future callback path', () => {
    expect(parseDeepLink('suishendazi://open', 'suishendazi')).toBe('focus-primary-window')
    expect(parseDeepLink('suishendazi://open/', 'suishendazi')).toBe('focus-primary-window')
    expect(parseDeepLink('suishendazi://auth/callback?code=redacted', 'suishendazi')).toBe('focus-primary-window')
  })

  it('keeps reading legacy dsh://open without claiming unrelated dsh paths', () => {
    expect(parseDeepLink('dsh://open', 'suishendazi')).toBe('focus-primary-window')
    expect(parseDeepLink('dsh://open/', 'suishendazi')).toBe('focus-primary-window')
    expect(parseDeepLink('dsh://', 'suishendazi')).toBe('focus-primary-window')
    expect(parseDeepLink('dsh://auth/callback?code=redacted', 'suishendazi')).toBeUndefined()
    expect(parseDeepLink('dsh://evil', 'suishendazi')).toBeUndefined()
  })

  it('keeps upstream behavior when the bundle itself declares dsh', () => {
    expect(parseDeepLink('dsh://open', 'dsh')).toBe('focus-primary-window')
    expect(parseDeepLink('dsh://evil', 'dsh')).toBeUndefined()
  })

  it('ignores other schemes and malformed payloads', () => {
    expect(parseDeepLink('https://example.com/open', 'suishendazi')).toBeUndefined()
    expect(parseDeepLink('suishendazi-evil://open', 'suishendazi')).toBeUndefined()
    expect(parseDeepLink('not a url', 'suishendazi')).toBeUndefined()
    expect(parseDeepLink('', 'suishendazi')).toBeUndefined()
  })
})
