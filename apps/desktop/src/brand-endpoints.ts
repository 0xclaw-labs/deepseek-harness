/**
 * Brand deployment endpoints for the 随身搭子 desktop.
 *
 * The branded app talks to the PaiNuo ecosystem account shim and model proxy,
 * never to a DeepSeek-operated service. This module is the single runtime copy
 * of those defaults; `custom/branding/brand.json` records the same values for
 * packaging and review, and `apps/desktop/tests/brand-endpoints.spec.ts` pins
 * the two together. Upstream adapters may still describe their own public
 * endpoints in source, but the branded composition disables those rows. Catalog
 * display names come from `./model-display.ts`, so the patch this module
 * generates shows the brand while every wire id stays the provider's own.
 *
 * @module
 */

import { displayModelName, displayProviderName } from './model-display.ts'

/** PaiNuo ecosystem account shim origin (login redirect, grant exchange, account). */
export const BRAND_AUTH_ORIGIN = 'https://auth.modelxing.com'

/** OpenAI-compatible PaiNuo model proxy base URL. */
export const BRAND_INFERENCE_BASE_URL = `${BRAND_AUTH_ORIGIN}/pi/v1`

/** Live PaiNuo model catalog used to generate the desktop provider patch. */
export const BRAND_MODEL_CATALOG_URL = `${BRAND_INFERENCE_BASE_URL}/models`

/** Provider id written into the generated profile patch. */
export const BRAND_PROVIDER_ID = 'painuo'

/** Preferred default model id; the live catalog may expose a different first entry. */
export const BRAND_DEFAULT_MODEL_ID = 'deepseek-v4.1-flash-1017-local'

/** Hosts owned by DeepSeek that a branded build must never contact by default. */
const UPSTREAM_DEEPSEEK_DOMAINS = ['deepseek.com', 'deepseeksvc.com'] as const

/** Environment variables that can silently redirect the branded app upstream. */
const ENDPOINT_OVERRIDE_ENV = [
  'DSH_PLATFORM_ORIGIN',
  'DSH_INFERENCE_ORIGIN',
  'DEEPSEEK_BASE_URL',
  'DSH_TELEMETRY_OTLP_URL',
  'DSH_PRODUCT_ANALYTICS_OTLP_URL',
  'DSH_DESKTOP_UPDATE_ORIGIN',
  'DOWNLOAD_TEST_ORIGIN',
] as const

/** Return whether a hostname belongs to a DeepSeek-operated service. */
export function isUpstreamDeepSeekHost(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase().replace(/\.$/u, '')
  return UPSTREAM_DEEPSEEK_DOMAINS.some(domain => normalized === domain || normalized.endsWith(`.${domain}`))
}

/** Return whether a URL points at a DeepSeek-operated service. */
export function isUpstreamDeepSeekUrl(value: string): boolean {
  try {
    return isUpstreamDeepSeekHost(new URL(value).hostname)
  } catch {
    return false
  }
}

/**
 * Reject a deployment endpoint that belongs to DeepSeek.
 * @param value - endpoint or origin to validate.
 * @param label - configuration field named in the failure.
 * @returns the parsed URL when it is not an upstream service.
 * @throws when the endpoint is malformed or upstream-owned.
 */
export function assertBrandEndpoint(value: string, label: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${label} must be an absolute URL`)
  }
  if (isUpstreamDeepSeekHost(url.hostname)) {
    throw new Error(`${label} must not point at an upstream DeepSeek service (${url.hostname})`)
  }
  return url
}

/**
 * Fail closed when the launching environment overrides a brand endpoint with an
 * upstream DeepSeek service. Host profiles and user shells may carry stale
 * DSH_* variables from the upstream app; starting with them would silently
 * reintroduce the endpoint this fork exists to replace.
 * @param env - process environment to inspect.
 * @throws when any endpoint override names an upstream DeepSeek host.
 */
export function assertNoUpstreamEndpointOverrides(env: NodeJS.ProcessEnv): void {
  for (const name of ENDPOINT_OVERRIDE_ENV) {
    const value = env[name]?.trim()
    if (value !== undefined && value !== '' && isUpstreamDeepSeekUrl(value)) {
      throw new Error(`${name} must not point at an upstream DeepSeek service; unset it or use the PaiNuo branded endpoint`)
    }
  }
}

/** One chat model returned by the PaiNuo catalog. */
export interface BrandCatalogModel {
  readonly id: string
  readonly name: string
}

/**
 * Pick the default model for the generated provider patch.
 * @param models - live catalog entries in server order.
 * @param preferred - model id to use when present.
 * @returns the preferred id, else the first catalog id, else undefined.
 */
export function chooseDefaultModel(
  models: readonly BrandCatalogModel[],
  preferred: string = BRAND_DEFAULT_MODEL_ID,
): string | undefined {
  if (models.some(model => model.id === preferred)) return preferred
  return models[0]?.id
}

/**
 * Read a grant written by the PaiNuo account shim out of the credential document.
 * Only a brand-issued opaque grant may become the model proxy bearer; an
 * upstream DeepSeek account token in the same document is never forwarded.
 * @param text - complete `$DSH_HOME/.credentials.yaml` contents.
 * @returns the grant token, or undefined when no valid brand record exists.
 */
export function readPaiNuoGrant(text: string): string | undefined {
  const start = text.indexOf('deepseek-account-platform/default:')
  if (start === -1) return undefined
  const block = text.slice(start, start + 512)
  const token = /token:\s*(\S+)/u.exec(block)?.[1]
  const issuer = /issuer:\s*(\S+)/u.exec(block)?.[1]
  if (token === undefined || issuer !== BRAND_AUTH_ORIGIN || !token.startsWith('sdzdsh_')) return undefined
  return token
}

/**
 * Generate the profile patch that mounts the PaiNuo provider and selects its
 * default model. An empty catalog produces no patch, so a signed-out app keeps
 * the brand provider disabled rather than falling back to an upstream route.
 *
 * Each entry keeps the catalog's wire id and gains a branded display name
 * (`displayModelName`); the adapter resolves requests, the session log, and the
 * agent default by id, so a rename here never reaches the wire.
 * @param models - live PaiNuo catalog entries.
 * @returns YAML patch block, or an empty string without a catalog.
 */
export function paiNuoProviderPatch(models: readonly BrandCatalogModel[]): string {
  const defaultModel = chooseDefaultModel(models)
  if (defaultModel === undefined) return ''
  const list = models
    .map(model => JSON.stringify({ id: model.id, name: displayModelName(model.id, model.name) }))
    .join(',')
  return '# paiNuo-model-provider: PaiNuo ecosystem model catalog (auth.modelxing.com proxy).\n'
    + '- id: llm-pi-ai\n'
    + '  config:\n'
    + '    providers:\n'
    + `      ${BRAND_PROVIDER_ID}:\n`
    + `        displayName: ${displayProviderName(BRAND_PROVIDER_ID)}\n`
    + '        apiKeyEnv: DSH_PAINUO_TOKEN\n'
    + '        api: openai-completions\n'
    + `        baseURL: ${BRAND_INFERENCE_BASE_URL}\n`
    + '        defaultContextWindow: 131072\n'
    + '        defaultMaxTokens: 8192\n'
    + `        models: [${list}]\n`
    + '- id: agent-default-model\n'
    + '  config:\n'
    + `    provider: ${BRAND_PROVIDER_ID}\n`
    + `    model: ${JSON.stringify(defaultModel)}\n`
}

/**
 * Fetch the PaiNuo model catalog with the account grant.
 * @param grant - brand-issued opaque grant.
 * @param fetchImpl - fetch implementation (injected in tests).
 * @param timeoutMs - request deadline.
 * @returns validated chat models, or an empty list on any failure.
 */
export async function fetchPaiNuoModels(
  grant: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 5_000,
): Promise<BrandCatalogModel[]> {
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, timeoutMs)
  try {
    const response = await fetchImpl(BRAND_MODEL_CATALOG_URL, {
      headers: { authorization: `Bearer ${grant}` }, signal: controller.signal,
    })
    if (!response.ok) return []
    const payload = await response.json() as { data?: Array<{ id?: unknown; endpoint?: unknown; object?: unknown }> }
    const seen = new Set<string>()
    const models: BrandCatalogModel[] = []
    for (const item of payload.data ?? []) {
      if (typeof item?.id !== 'string' || item.id.length === 0 || seen.has(item.id)) continue
      if (item.endpoint !== undefined && item.endpoint !== '/v1/chat/completions') continue
      if (item.endpoint === undefined && item.object !== 'model') continue
      seen.add(item.id)
      models.push({ id: item.id, name: item.id })
    }
    return models
  } catch (_error) {
    return []
  } finally {
    clearTimeout(timer)
  }
}
