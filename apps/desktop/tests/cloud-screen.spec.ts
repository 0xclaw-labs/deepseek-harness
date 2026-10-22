import { describe, expect, it, vi } from 'vitest'
import {
  classifyGatewayCredential,
  cloudScreenConsoleUrl,
  cloudScreenDelegateUrlAllowed,
  cloudScreenExternalUrlAllowed,
  planCloudScreen,
  requestCloudScreenDelegate,
  resolveCloudScreenCredential,
} from '../src/cloud-screen.ts'
import { BRAND_CLOUD_DESKTOP_API_ORIGIN } from '../src/brand-endpoints.ts'

const origin = BRAND_CLOUD_DESKTOP_API_ORIGIN
const scrn = 'scrn_01HZZZZZZZZZZZZZZZZZZZZZQA'
const ticket = 'djF8eyJrIjoiZGVsZWdhdGUifQ'
const grantedUrl = `${origin}/api/npw/screen/${scrn}/delegate/open?d=${ticket}&c=desktop`

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('gateway credential classification', () => {
  it('routes the two wire forms the gateway accepts', () => {
    expect(classifyGatewayCredential('sdzs_0123456789abcdef')).toBe('account_session')
    expect(classifyGatewayCredential('eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJ1c3JfMSJ9.c2ln')).toBe('platform_jwt')
  })

  it('refuses the shim grant and anything malformed instead of sending it', () => {
    // The model-proxy grant is opaque and audience-bound: an agentbuddy gateway
    // answers 401, so it must never be sent as a platform credential.
    expect(classifyGatewayCredential('sdzdsh_abcdef')).toBe('unsupported')
    expect(classifyGatewayCredential('')).toBe('unsupported')
    expect(classifyGatewayCredential('   ')).toBe('unsupported')
    expect(classifyGatewayCredential('not-a-token')).toBe('unsupported')
    expect(classifyGatewayCredential('two.segments')).toBe('unsupported')
  })

  it('prefers the deployment credential seam over the stored shim grant', () => {
    const jwt = 'eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJ1c3JfMSJ9.c2ln'
    expect(resolveCloudScreenCredential({ DSH_CLOUD_SCREEN_TOKEN: jwt }, () => 'sdzdsh_shim')).toEqual({
      credential: jwt, kind: 'platform_jwt',
    })
    expect(resolveCloudScreenCredential({}, () => 'sdzdsh_shim')).toEqual({
      credential: 'sdzdsh_shim', kind: 'unsupported',
    })
    expect(resolveCloudScreenCredential({}, () => undefined)).toEqual({ credential: '', kind: 'unsupported' })
  })
})

describe('delegate URL restriction', () => {
  it('accepts only the gateway origin path for the requested screen with a ticket', () => {
    expect(cloudScreenDelegateUrlAllowed(grantedUrl, origin, scrn)).toBe(true)
    expect(cloudScreenDelegateUrlAllowed(`https://evil.example.com/api/npw/screen/${scrn}/delegate/open?d=${ticket}`, origin, scrn)).toBe(false)
    expect(cloudScreenDelegateUrlAllowed(`${origin}/api/npw/screen/scrn_01HZZZZZZZZZZZZZZZZZZZZZQB/delegate/open?d=${ticket}`, origin, scrn)).toBe(false)
    expect(cloudScreenDelegateUrlAllowed(`${origin}/api/npw/screen/${scrn}/novnc/vnc.html?d=${ticket}`, origin, scrn)).toBe(false)
    expect(cloudScreenDelegateUrlAllowed(`${origin}/api/npw/screen/${scrn}/delegate/open?c=desktop`, origin, scrn)).toBe(false)
    expect(cloudScreenDelegateUrlAllowed(`https://u:p@agentbuddy.modelxing.com/api/npw/screen/${scrn}/delegate/open?d=${ticket}`, origin, scrn)).toBe(false)
    expect(cloudScreenDelegateUrlAllowed(grantedUrl, 'not an origin', scrn)).toBe(false)
  })
})

describe('delegate request', () => {
  it('posts to the gateway delegate path with the credential and channel=desktop', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { url: grantedUrl, screenId: scrn, mode: 'viewer', expiresAt: 1_792_100_060 }))
    const result = await requestCloudScreenDelegate({
      screenId: scrn, credential: 'sdzs_session', fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(result).toEqual({ kind: 'granted', url: grantedUrl, expiresAt: 1_792_100_060, mode: 'viewer' })
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`${origin}/api/npw/screen/${scrn}/delegate?channel=desktop`)
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sdzs_session')
  })

  it('never sends an unsupported credential', async () => {
    const fetchImpl = vi.fn()
    const result = await requestCloudScreenDelegate({
      screenId: scrn, credential: 'sdzdsh_shim', fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(result).toEqual({ kind: 'unavailable', reason: 'credential_unsupported_for_gateway' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('requires a screen id and a credential', async () => {
    expect(await requestCloudScreenDelegate({ screenId: '  ', credential: 'sdzs_x' })).toEqual({
      kind: 'unavailable', reason: 'screen_id_required',
    })
    expect(await requestCloudScreenDelegate({ screenId: scrn, credential: '' })).toEqual({
      kind: 'unavailable', reason: 'credential_missing',
    })
  })

  it('maps gateway refusals to their contract code and 503 to a capability gap', async () => {
    const refused = await requestCloudScreenDelegate({
      screenId: scrn, credential: 'sdzs_x',
      fetchImpl: (async () => jsonResponse(403, { error: 'lease_not_holder' })) as unknown as typeof fetch,
    })
    expect(refused).toEqual({ kind: 'refused', status: 403, code: 'lease_not_holder' })
    const absent = await requestCloudScreenDelegate({
      screenId: scrn, credential: 'sdzs_x',
      fetchImpl: (async () => jsonResponse(503, { code: 'provider_unavailable' })) as unknown as typeof fetch,
    })
    expect(absent).toEqual({ kind: 'unavailable', reason: 'capability_absent' })
  })

  it('rejects a fabricated payload instead of opening it', async () => {
    for (const body of [
      null,
      {},
      { url: grantedUrl, screenId: scrn, expiresAt: 0, mode: 'viewer' },
      { url: grantedUrl, screenId: 'scrn_01HZZZZZZZZZZZZZZZZZZZZZQB', expiresAt: 1, mode: 'viewer' },
      { url: `https://evil.example.com/api/npw/screen/${scrn}/delegate/open?d=${ticket}`, screenId: scrn, expiresAt: 1, mode: 'viewer' },
      { url: `${origin}/api/npw/screen/${scrn}/delegate/open?c=desktop`, screenId: scrn, expiresAt: 1, mode: 'viewer' },
    ]) {
      const result = await requestCloudScreenDelegate({
        screenId: scrn, credential: 'sdzs_x',
        fetchImpl: (async () => jsonResponse(200, body)) as unknown as typeof fetch,
      })
      expect(result).toEqual({ kind: 'unavailable', reason: 'bad_payload' })
    }
  })

  it('reports network failure and timeout without inventing a URL', async () => {
    const offline = await requestCloudScreenDelegate({
      screenId: scrn, credential: 'sdzs_x',
      fetchImpl: (async () => { throw new Error('offline') }) as unknown as typeof fetch,
    })
    expect(offline).toEqual({ kind: 'unavailable', reason: 'network' })
    // A fetch that only settles when its signal aborts: the deadline is the
    // reason, not an unrelated transport failure.
    const timeout = await requestCloudScreenDelegate({
      screenId: scrn, credential: 'sdzs_x', timeoutMs: 5,
      fetchImpl: ((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => { reject(new Error('aborted')) })
      })) as unknown as typeof fetch,
    })
    expect(timeout).toEqual({ kind: 'unavailable', reason: 'timeout' })
  })
})

describe('open plan', () => {
  it('grants the Sidebar guest only when the gateway issued a ticket', () => {
    expect(planCloudScreen({ kind: 'granted', url: grantedUrl, expiresAt: 1, mode: 'viewer' })).toEqual({
      kind: 'sidebar-guest', url: grantedUrl,
    })
  })

  it('falls back to the system browser with the reason, and refuses without a screen', () => {
    expect(planCloudScreen({ kind: 'unavailable', reason: 'credential_unsupported_for_gateway' })).toEqual({
      kind: 'system-browser', url: cloudScreenConsoleUrl(), reason: 'credential_unsupported_for_gateway',
    })
    expect(planCloudScreen({ kind: 'refused', status: 410, code: 'lease_expired' })).toEqual({
      kind: 'system-browser', url: cloudScreenConsoleUrl(), reason: 'refused',
    })
    expect(planCloudScreen({ kind: 'unavailable', reason: 'screen_id_required' })).toEqual({
      kind: 'unavailable', reason: 'screen_id_required',
    })
  })

  it('points the fallback at the branded gateway console, never an upstream host', () => {
    expect(cloudScreenConsoleUrl()).toBe(`${BRAND_CLOUD_DESKTOP_API_ORIGIN}/console.html`)
  })

  it('lets the shell open only gateway-origin URLs', () => {
    expect(cloudScreenExternalUrlAllowed(cloudScreenConsoleUrl())).toBe(true)
    expect(cloudScreenExternalUrlAllowed(grantedUrl)).toBe(true)
    expect(cloudScreenExternalUrlAllowed('https://evil.example.com/console.html')).toBe(false)
    expect(cloudScreenExternalUrlAllowed('file:///etc/passwd')).toBe(false)
    expect(cloudScreenExternalUrlAllowed('dsh-app://app/')).toBe(false)
    expect(cloudScreenExternalUrlAllowed('https://u:p@agentbuddy.modelxing.com/console.html')).toBe(false)
    expect(cloudScreenExternalUrlAllowed('not a url')).toBe(false)
  })
})
