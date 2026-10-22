/**
 * Brand display names for the model catalogs this deployment mints.
 *
 * The PaiNuo proxy advertises models by wire id, so the generated provider
 * patch would otherwise show raw ids such as `deepseek-v4.1-flash-1017-local`
 * in the model selector and on the Models settings page. This module owns the
 * display rules for that catalog: the wire id keeps carrying the provider's
 * protocol id into every request, and a route or model this deployment does not
 * serve is returned untouched rather than guessed.
 *
 * @module @deepseek-ai/dsh-desktop/model-display
 */

/** Catalog display name of the branded proxy route. */
export const BRAND_PROVIDER_DISPLAY_NAME = '派诺生态'

/** Prefix every branded catalog entry's display name carries. */
export const BRAND_MODEL_DISPLAY_PREFIX = '派诺·'

/**
 * Provider routes this deployment serves itself, and the name each one shows.
 * `painuo` is the branded `llm-pi-ai` route the Desktop writes into the profile
 * patch; every other route keeps the name its own catalog advertises.
 */
const BRAND_PROVIDER_NAMES: Readonly<Record<string, string>> = {
  painuo: BRAND_PROVIDER_DISPLAY_NAME,
}

/**
 * Name one provider route in a model catalog.
 * @param providerId - route id from the deployment's provider directory.
 * @param fallback - the route's own catalog name, or its id when it has none.
 * @returns the branded name for this deployment's proxy route, else `fallback`.
 */
export function displayProviderName(providerId: string, fallback: string = providerId): string {
  return BRAND_PROVIDER_NAMES[providerId.trim()] ?? fallback
}

/**
 * Canonical spellings for vendor words the proxy lowercases in its wire ids,
 * taken from the spellings the same catalog already uses elsewhere. Only letter
 * case is corrected; a vendor that is not listed keeps its own letters and
 * capitalizes its first one instead, so no product identity is invented.
 */
const VENDOR_WORD_SPELLINGS: Readonly<Record<string, string>> = {
  deepseek: 'DeepSeek',
  glm: 'GLM',
}

/**
 * Readability pass over one hyphen-separated display token: a version prefix
 * (`v4.1`) uppercases its `v`, a listed vendor word takes its canonical
 * spelling, and any other token that starts with a lowercase letter capitalizes
 * that letter. Numeric, mixed-case, and vendor-styled tokens stay
 * byte-identical, so no character of the provider's own name is invented.
 * @param token - one `-`-separated token of a model name.
 * @returns the token as it is displayed.
 */
function displayToken(token: string): string {
  if (/^v\d/u.test(token)) return `V${token.slice(1)}`
  const canonical = VENDOR_WORD_SPELLINGS[token]
  if (canonical !== undefined) return canonical
  if (/^[a-z]/u.test(token)) return `${token.charAt(0).toUpperCase()}${token.slice(1)}`
  return token
}

/**
 * Display name for one catalog model.
 *
 * The wire id is never altered: this name only reaches catalog labels, while
 * `id` keeps carrying the provider's protocol id into selection, requests, and
 * the session log. A name that already carries the brand prefix stays as it is,
 * so the rule is idempotent over an already-branded catalog.
 *
 * @param modelId - the provider's wire model id.
 * @param catalogName - the name the catalog advertises, when it advertises one.
 * @returns the branded display name, else the untouched catalog name or id.
 */
export function displayModelName(modelId: string, catalogName?: string): string {
  const advertised = catalogName?.trim() ?? ''
  const base = advertised === '' ? modelId.trim() : advertised
  if (base === '' || base.startsWith(BRAND_MODEL_DISPLAY_PREFIX)) return base
  return `${BRAND_MODEL_DISPLAY_PREFIX}${base.split('-').map(displayToken).join('-')}`
}
