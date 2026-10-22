#!/usr/bin/env node
// Brand-default guard: fail when a branded build could reach a DeepSeek-operated
// service by default. Run from build-unsigned.sh and locally after changing a
// composition, provider default, update destination, or client settings copy.
//
// This checks defaults and enabled composition rows, not every explicitly
// user-configured BYO provider or upstream test fixture.
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as yaml from 'js-yaml'
import { entryListSchema } from '../../vendor/include/lib/index.js'

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const failures = []
const notes = []

function fail(message) { failures.push(message) }
function read(relative) { return readFileSync(join(root, relative), 'utf8') }
function upstreamHosts(text) {
  return [...text.matchAll(/https?:\/\/[^\s'"`)]+/gu)]
    .map(match => { try { return new URL(match[0]).hostname } catch { return undefined } })
    .filter(host => host !== undefined && (host === 'deepseek.com' || host.endsWith('.deepseek.com')
      || host === 'deepseeksvc.com' || host.endsWith('.deepseeksvc.com')))
}
function rejectUpstreamText(relative, text) {
  const hosts = [...new Set(upstreamHosts(text))]
  if (hosts.length > 0) fail(`${relative} still names upstream endpoint(s): ${hosts.join(', ')}`)
}
function rowsOf(relative) {
  const parsed = yaml.load(read(relative), { schema: entryListSchema })
  if (!Array.isArray(parsed)) throw new TypeError(`${relative} must parse to a patch list`)
  return parsed.flatMap(patch => typeof patch === 'object' && patch !== null ? patch.insert ?? [] : [])
}
function expectDisabled(rows, id) {
  const row = rows.find(candidate => candidate.id === id)
  if (row === undefined) fail(`${id} is missing from the base composition`)
  else if (row.disabled !== true) fail(`${id} must be disabled in the brand composition`)
}
function expectNoUpstreamInEnabledRows(relative, rows) {
  for (const row of rows) {
    if (row.disabled === true) continue
    rejectUpstreamText(`${relative} row ${String(row.id)}`, JSON.stringify(row))
  }
}

// Brand manifest is the reviewed deployment record.
const brand = JSON.parse(read('custom/branding/brand.json'))
if (brand.endpoints?.authOrigin !== 'https://auth.modelxing.com') fail('brand auth origin must be auth.modelxing.com')
if (brand.endpoints?.inferenceBaseUrl !== 'https://auth.modelxing.com/pi/v1') fail('brand inference base URL must be the PaiNuo pi proxy')
if (brand.endpoints?.updateFeed !== null) fail('brand updateFeed must stay null until a PaiNuo feed exists')
if (brand.endpoints?.webSearch !== null) fail('brand webSearch must stay null until a PaiNuo search service exists')
if (brand.endpoints?.telemetry !== null) fail('brand telemetry must stay null until a PaiNuo collector exists')
if (!Array.isArray(brand.endpoints?.pluginMarketIndexes) || brand.endpoints.pluginMarketIndexes.length !== 0) {
  fail('brand pluginMarketIndexes must be empty: the app must not pretend an upstream/default market exists')
}

// Base composition: only the PaiNuo provider is enabled; official routes are off.
const base = rowsOf('packages/bundle/base/cordis.patch.yml')
for (const id of ['llm-deepseek', 'llm-deepseek-account', 'session-log-deepseek',
  'web-search-deepseek', 'web-deepseek-api', 'session-telemetry-otel']) expectDisabled(base, id)
const defaultModel = base.find(row => row.id === 'agent-default-model')
if (defaultModel?.config?.provider !== 'painuo') fail('agent-default-model must start on the painuo provider')
if (typeof defaultModel?.config?.model !== 'string' || defaultModel.config.model.length === 0) {
  fail('agent-default-model must name a model')
}
const web = base.find(row => row.id === 'web')
if (web?.config?.searchProvider !== undefined) fail('web.searchProvider must be omitted: no PaiNuo search provider is wired')
const toolWeb = base.find(row => row.id === 'tool-web')
if (toolWeb?.config?.search !== false) fail('tool-web.search must be false while no PaiNuo search provider exists')
const telemetry = base.find(row => row.id === 'session-telemetry-otel')
if (telemetry?.config?.mode !== 'DISABLED') fail('session telemetry must default to DISABLED')
expectNoUpstreamInEnabledRows('packages/bundle/base/cordis.patch.yml', base)

// Web surface: no upstream product analytics or upstream web-search settings page.
const webApp = rowsOf('packages/bundle/web-app/cordis.patch.yml')
for (const id of ['desktop-product-telemetry', 'product-analytics', 'ui-settings-web-search']) expectDisabled(webApp, id)
expectNoUpstreamInEnabledRows('packages/bundle/web-app/cordis.patch.yml', webApp)

// Desktop runtime defaults.
const brandEndpoints = read('apps/desktop/src/brand-endpoints.ts')
for (const expected of ['https://auth.modelxing.com', '/pi/v1', '/models']) {
  if (!brandEndpoints.includes(expected)) fail(`apps/desktop/src/brand-endpoints.ts is missing ${expected}`)
}
rejectUpstreamText('apps/desktop/src/brand-endpoints.ts', brandEndpoints)
rejectUpstreamText('apps/desktop/src/main.ts', read('apps/desktop/src/main.ts'))

if (!read('packages/credentials/deepseek-account-platform/src/index.ts')
  .includes("'https://auth.modelxing.com'")) fail('account platform defaults are not branded')
if (!read('packages/host/product-telemetry-otel/src/index.ts').includes("endpoint: z.string().default('')")) {
  fail('product telemetry must have no implicit collector endpoint')
}
if (!read('packages/boot/plugin-market/src/index.ts').includes('default([])')) {
  fail('plugin market defaults must stay empty')
}

// Client product copy: DSH_CLIENT_TITLE is fixed into every Vite and tsdown
// artifact, so the branded build must pin it. Inheriting it ships the upstream
// name as the packaged product title.
const buildScript = read('scripts/custom/build-unsigned.sh')
if (!/^\s*DSH_CLIENT_TITLE="\$PRODUCT_NAME"\s+pnpm run build$/mu.test(buildScript)) {
  fail('scripts/custom/build-unsigned.sh must pin DSH_CLIENT_TITLE="$PRODUCT_NAME" on the client build')
}
// Native desktop copy the product-name rule alone cannot reach: the welcome
// key screen still asked for the upstream provider.
const replacements = JSON.parse(read('custom/branding/replacements.json'))
const rules = new Map((replacements.replacements ?? []).map(rule => [rule.from, rule.to]))
for (const [from, to] of [['DeepSeek Harness', '随身搭子'], ['official DeepSeek models', 'your PaiNuo models'],
  ['DeepSeek 官方模型', '派诺模型'], ['start using Harness', 'start using 随身搭子']]) {
  if (rules.get(from) !== to) fail(`brand replacements must map ${JSON.stringify(from)} to ${JSON.stringify(to)}`)
}
// Expected-output fixtures describe what the branded product prints, so they
// must follow the branded sources. Every fixture that pins upstream product
// copy has to be named; the directory walk cannot reach it under `tests/`.
const expectedDir = 'apps/desktop/tests/expected'
const listed = new Set(replacements.includeFiles ?? [])
/** Collect every JSON fixture under the expected-output tree, nested directories included. */
function expectedFixtures(dir) {
  const found = []
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    const relative = `${dir}/${entry.name}`
    if (entry.isDirectory()) found.push(...expectedFixtures(relative))
    else if (entry.isFile() && entry.name.endsWith('.json')) found.push(relative)
  }
  return found
}
for (const relative of expectedFixtures(expectedDir)) {
  if (read(relative).includes('DeepSeek Harness') && !listed.has(relative)) {
    fail(`${relative} pins the upstream product name; add it to brand replacements includeFiles`)
  }
}
const aboutPanel = JSON.parse(read('apps/desktop/tests/expected/about-panel.json'))
if (aboutPanel['darwin:en-US']?.menu?.[0]?.label !== 'About DeepSeek Harness') {
  fail('apps/desktop/tests/expected/about-panel.json no longer matches the upstream menu copy the brand rule rewrites')
}
const desktopLocale = read('apps/desktop/src/locale.ts')
for (const expected of ["welcomeKeyDescription: 'Configure official DeepSeek models to start using Harness'",
  "welcomeKeyDescription: '配置 DeepSeek 官方模型，即可开始使用'"]) {
  if (!desktopLocale.includes(expected)) {
    fail(`apps/desktop/src/locale.ts no longer carries ${JSON.stringify(expected)}; update replacements.json`)
  }
}

// Build-time update destination: no official feed, and production must name one.
const update = read('apps/desktop/scripts/desktop-auto-update-environment.mjs')
if (update.includes("'https://download.deepseek.com'")) fail('production update feed must not default to download.deepseek.com')
if (!update.includes("originEnvName: 'DSH_DESKTOP_UPDATE_ORIGIN'")) fail('production update feed must require a brand origin')
if (!read('apps/desktop/scripts/desktop-publish-config.ts').includes('must not point at an upstream DeepSeek service')) {
  fail('publish config must reject an upstream origin')
}

notes.push('auth/model proxy: auth.modelxing.com/pi/v1')
notes.push('default model route: painuo (catalog-derived)')
notes.push('official providers: disabled (llm-deepseek, llm-deepseek-account, session-log)')
notes.push('web search: disabled until a PaiNuo service exists; fetch stays local')
notes.push('telemetry: disabled; no upstream collector default')
notes.push('update feed: none in unsigned builds; production requires DSH_DESKTOP_UPDATE_ORIGIN')
notes.push('plugin market: empty default (user must add an index)')

if (failures.length > 0) {
  for (const failure of failures) console.error(`brand-defaults: FAIL: ${failure}`)
  process.exit(1)
}
console.log('brand-defaults: PASS')
for (const note of notes) console.log(`  ${note}`)
