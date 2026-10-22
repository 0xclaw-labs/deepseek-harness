#!/usr/bin/env node
// Brand-default guard: fail when a branded build could reach a DeepSeek-operated
// service by default. Run from build-unsigned.sh and locally after changing a
// composition, provider default, update destination, or client settings copy.
//
// This checks defaults and enabled composition rows, not every explicitly
// user-configured BYO provider or upstream test fixture.
import { readFileSync } from 'node:fs'
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

// Build-time update destination: no official feed, and production must name one.
const update = read('apps/desktop/scripts/desktop-auto-update-environment.mjs')
if (update.includes("'https://download.deepseek.com'")) fail('production update feed must not default to download.deepseek.com')
if (!update.includes("originEnvName: 'DSH_DESKTOP_UPDATE_ORIGIN'")) fail('production update feed must require a brand origin')
if (!read('apps/desktop/scripts/desktop-publish-config.ts').includes('must not point at an upstream DeepSeek service')) {
  fail('publish config must reject an upstream origin')
}

// Runtime update policy: the sealed feed is re-validated, and a build without
// one reports that state instead of a fake check failure. "Automatic updates
// are disabled" is never presented as "an update source is configured".
const updateSource = read('apps/desktop/src/update-source.ts')
if (!updateSource.includes('isUpstreamDeepSeekHost')) fail('the packaged feed must reject upstream DeepSeek hosts')
if (!updateSource.includes("reason: 'upstream-host'")) fail('the packaged feed must name its upstream rejection')
const coordinator = read('apps/desktop/src/update-coordinator.ts')
if (!coordinator.includes("from './update-source.ts'")) fail('the update coordinator must consult the validated source')
if (!coordinator.includes("this.source.kind !== 'configured'")) fail('the update coordinator must refuse a non-configured source')
if (coordinator.includes('has no packaged update source')) {
  fail('the update coordinator must not report a missing feed as a raw check failure')
}
const desktopShell = read('apps/desktop/src/main.ts')
if (!desktopShell.includes('desktopUpdateUnavailableContent')) {
  fail('the desktop shell must state an unusable update source instead of failing a check')
}
if (!updateSource.includes("kind: 'absent'") || !updateSource.includes("reason: 'channel-mismatch'")) {
  fail('the packaged feed must distinguish an absent feed from a rejected one')
}

notes.push('auth/model proxy: auth.modelxing.com/pi/v1')
notes.push('default model route: painuo (catalog-derived)')
notes.push('official providers: disabled (llm-deepseek, llm-deepseek-account, session-log)')
notes.push('web search: disabled until a PaiNuo service exists; fetch stays local')
notes.push('telemetry: disabled; no upstream collector default')
notes.push('update feed: none in unsigned builds; production requires DSH_DESKTOP_UPDATE_ORIGIN')
notes.push('update runtime: sealed feed re-validated; no feed reports "no automatic updates", never a failed check')
notes.push('plugin market: empty default (user must add an index)')

if (failures.length > 0) {
  for (const failure of failures) console.error(`brand-defaults: FAIL: ${failure}`)
  process.exit(1)
}
console.log('brand-defaults: PASS')
for (const note of notes) console.log(`  ${note}`)
