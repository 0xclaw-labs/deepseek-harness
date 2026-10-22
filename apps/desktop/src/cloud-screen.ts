/**
 * Cross-client live cloud desktop: the desktop half of the delegate-ticket seam.
 *
 * The Sidebar Browser guest runs in its own Electron partition
 * (`browser-guests.ts`), so it carries no platform session and cannot open the
 * gateway's noVNC surface by itself. The gateway therefore issues a one-time,
 * short-lived delegate URL to an already-authenticated client; whoever opens it
 * lands in the same screen lease without a second sign-in.
 *
 * This module owns the main-process half: classify the stored credential, ask
 * the gateway for a delegate URL, and decide between the Sidebar guest and the
 * system browser. It performs no UI work and never opens anything itself.
 *
 * Honest failure: the branded shim grant (`sdzdsh_`, the model-proxy
 * credential) is *not* accepted by the gateway, which takes a platform JWT or a
 * `sdzs_` account session. That credential is refused locally with
 * `credential_unsupported_for_gateway` instead of being sent to a gateway that
 * would answer 401; the caller then falls back to the system browser, where the
 * platform SSO session already lives.
 *
 * @module
 */

import { BRAND_CLOUD_DESKTOP_API_ORIGIN } from './brand-endpoints.ts'

/** Credential wire forms the gateway's `RequirePrincipal` accepts. */
export type GatewayCredentialKind = 'platform_jwt' | 'account_session' | 'unsupported'

/**
 * Classify a stored credential by its wire form.
 * @param token - credential text from the environment or credential document.
 * @returns the form the gateway routes on, or `unsupported` for anything else.
 */
export function classifyGatewayCredential(token: string | undefined): GatewayCredentialKind {
  const value = token?.trim() ?? ''
  if (value === '') return 'unsupported'
  if (value.startsWith('sdzs_')) return 'account_session'
  // A JWS compact serialization: three base64url segments. Only the form is
  // classified here; the gateway verifies signature, issuer, and audience.
  if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(value)) return 'platform_jwt'
  return 'unsupported'
}

/** Why a delegate URL could not be produced. */
export type CloudScreenUnavailableReason =
  | 'credential_unsupported_for_gateway'
  | 'credential_missing'
  | 'screen_id_required'
  | 'origin_refused'
  | 'capability_absent'
  | 'bad_payload'
  | 'network'
  | 'timeout'

/** Outcome of one delegate request. */
export type CloudScreenDelegateResult =
  | { readonly kind: 'granted'; readonly url: string; readonly expiresAt: number; readonly mode: string }
  | { readonly kind: 'refused'; readonly status: number; readonly code: string }
  | { readonly kind: 'unavailable'; readonly reason: CloudScreenUnavailableReason }

/**
 * Restrict an opened URL to the gateway's own delegate-redeem endpoint for the
 * requested screen. The gateway's answer is a credential: a compromised or
 * proxied gateway must not be able to turn it into an arbitrary navigation.
 * @param raw - URL from the gateway response.
 * @param origin - configured gateway origin.
 * @param screenId - screen the caller asked for.
 * @returns whether the URL may be opened (or handed to a guest).
 */
export function cloudScreenDelegateUrlAllowed(raw: string, origin: string, screenId: string): boolean {
  if (raw === '' || origin === '' || screenId === '') return false
  let url: URL
  try {
    url = new URL(raw)
  } catch (_error) {
    return false
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false
  if (url.username !== '' || url.password !== '') return false
  if (url.origin !== origin) return false
  if (url.pathname !== `/api/npw/screen/${screenId}/delegate/open`) return false
  return (url.searchParams.get('d') ?? '') !== ''
}

const responseCode = (body: unknown, status: number): string => {
  if (typeof body === 'object' && body !== null) {
    const record = body as Record<string, unknown>
    if (typeof record.code === 'string' && record.code !== '') return record.code
    if (typeof record.error === 'string' && record.error !== '') return record.error
  }
  return `http_${status}`
}

/** One delegate request. */
export interface CloudScreenDelegateRequest {
  /** Screen channel id (`scrn_…`) the caller wants to open. */
  readonly screenId: string
  /** Gateway credential (platform JWT or `sdzs_` account session). */
  readonly credential: string
  /** Gateway origin override; defaults to the branded gateway. */
  readonly origin?: string
  /** Injected fetch (tests). */
  readonly fetchImpl?: typeof fetch
  /** Request deadline; defaults to 5s. */
  readonly timeoutMs?: number
}

/**
 * Ask the gateway for a one-time delegate URL
 * (`POST /api/npw/screen/{scrnId}/delegate?channel=desktop`).
 * @param request - screen id, credential, and injectable transport.
 * @returns the delegate URL, a gateway refusal with its error code, or an honest
 *   local unavailability reason (never a fabricated URL).
 */
export async function requestCloudScreenDelegate(
  request: CloudScreenDelegateRequest,
): Promise<CloudScreenDelegateResult> {
  const origin = request.origin ?? BRAND_CLOUD_DESKTOP_API_ORIGIN
  const screenId = request.screenId.trim()
  if (screenId === '') return { kind: 'unavailable', reason: 'screen_id_required' }
  const credential = request.credential.trim()
  if (credential === '') return { kind: 'unavailable', reason: 'credential_missing' }
  const kind = classifyGatewayCredential(credential)
  if (kind === 'unsupported') return { kind: 'unavailable', reason: 'credential_unsupported_for_gateway' }
  if (!URL.canParse(origin)) return { kind: 'unavailable', reason: 'origin_refused' }

  const fetchImpl = request.fetchImpl ?? fetch
  const controller = new AbortController()
  const timeout = setTimeout(() => { controller.abort() }, request.timeoutMs ?? 5_000)
  let response: Response
  try {
    response = await fetchImpl(`${origin}/api/npw/screen/${encodeURIComponent(screenId)}/delegate?channel=desktop`, {
      method: 'POST',
      headers: { authorization: `Bearer ${credential}` },
      signal: controller.signal,
    })
  } catch (_error) {
    // The deadline owns the distinction: an abort is our timeout, anything else
    // is the transport failing before a response arrived.
    return { kind: 'unavailable', reason: controller.signal.aborted ? 'timeout' : 'network' }
  } finally {
    clearTimeout(timeout)
  }

  let body: unknown = null
  try {
    body = await response.json()
  } catch (_error) {
    body = null
  }
  if (response.status === 503) return { kind: 'unavailable', reason: 'capability_absent' }
  if (!response.ok) return { kind: 'refused', status: response.status, code: responseCode(body, response.status) }
  if (typeof body !== 'object' || body === null) return { kind: 'unavailable', reason: 'bad_payload' }
  const record = body as Record<string, unknown>
  const url = typeof record.url === 'string' ? record.url : ''
  const returnedScreen = typeof record.screenId === 'string' ? record.screenId : ''
  const expiresAt = typeof record.expiresAt === 'number' ? record.expiresAt : 0
  const mode = typeof record.mode === 'string' ? record.mode : ''
  if (expiresAt <= 0 || returnedScreen !== screenId) return { kind: 'unavailable', reason: 'bad_payload' }
  if (!cloudScreenDelegateUrlAllowed(url, origin, screenId)) return { kind: 'unavailable', reason: 'bad_payload' }
  return { kind: 'granted', url, expiresAt, mode }
}

/** Where a cloud-desktop request should open. */
export type CloudScreenPlan =
  /** Open a Sidebar Browser tab with the one-time gateway URL. */
  | { readonly kind: 'sidebar-guest'; readonly url: string }
  /**
   * Open the gateway console in the system browser. The platform SSO session
   * lives there (same reasoning as the billing center), so this needs no grant
   * from the app; it is the honest fallback, not an equivalent of the Sidebar.
   */
  | { readonly kind: 'system-browser'; readonly url: string; readonly reason: CloudScreenUnavailableReason | 'refused' }
  /** Nothing can be opened; report why. */
  | { readonly kind: 'unavailable'; readonly reason: CloudScreenUnavailableReason }

/**
 * Turn a delegate result into an open decision.
 * @param result - delegate request outcome.
 * @returns the plan the renderer executes.
 */
export function planCloudScreen(result: CloudScreenDelegateResult): CloudScreenPlan {
  if (result.kind === 'granted') return { kind: 'sidebar-guest', url: result.url }
  if (result.kind === 'refused') return { kind: 'system-browser', url: cloudScreenConsoleUrl(), reason: 'refused' }
  if (result.reason === 'screen_id_required' || result.reason === 'credential_missing') return { kind: 'unavailable', reason: result.reason }
  return { kind: 'system-browser', url: cloudScreenConsoleUrl(), reason: result.reason }
}

/**
 * Restrict a shell-open to the branded gateway origin.
 *
 * The renderer may hand back a console URL or a delegate URL; neither needs an
 * arbitrary-URL opener, so anything off the gateway origin is refused here
 * rather than relying on the renderer's own check.
 * @param raw - URL received over IPC.
 * @returns whether the shell may open it.
 */
export function cloudScreenExternalUrlAllowed(raw: string): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch (_error) {
    return false
  }
  return (url.protocol === 'https:' || url.protocol === 'http:')
    && url.username === '' && url.password === '' && url.origin === BRAND_CLOUD_DESKTOP_API_ORIGIN
}

/**
 * Gateway console URL for the system-browser path.
 * @returns the branded console entry, which lists the caller's computers.
 */
export function cloudScreenConsoleUrl(): string {
  return `${BRAND_CLOUD_DESKTOP_API_ORIGIN}/console.html`
}

/**
 * Resolve the credential used for the delegate request.
 *
 * `DSH_CLOUD_SCREEN_TOKEN` is the deployment seam: when the platform issues an
 * agentbuddy-audience token (platform JWT or `sdzs_` session) the environment
 * carries it and the Sidebar path works with no code change. The branded shim
 * grant is deliberately not reused here — it is a model-proxy credential and
 * the gateway rejects it.
 * @param env - process environment.
 * @param readShimGrant - reads the account shim's stored grant, when present.
 * @returns the credential text (possibly empty) and its classified form.
 */
export function resolveCloudScreenCredential(
  env: NodeJS.ProcessEnv,
  readShimGrant: () => string | undefined,
): { credential: string; kind: GatewayCredentialKind } {
  const explicit = env.DSH_CLOUD_SCREEN_TOKEN?.trim() ?? ''
  if (explicit !== '') return { credential: explicit, kind: classifyGatewayCredential(explicit) }
  const shim = readShimGrant()?.trim() ?? ''
  return { credential: shim, kind: classifyGatewayCredential(shim) }
}
