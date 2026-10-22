#!/usr/bin/env node
// 0xclaw-labs/deepseek-harness fork: deterministic branding transform.
//
// Applied to a BUILD WORKTREE (never to the source checkout): exact product
// strings from replacements.json are substituted, then brand icon assets from
// brand.json are copied over upstream asset paths. Upstream files stay pristine
// in git, so upstream upgrades do not conflict on UI copy.
//
// A rule may carry `skipWhenPrecededBy`, which leaves an occurrence that already
// carries that prefix untouched; a prefix rule (`X -> 派诺·X`) therefore stays
// idempotent when --write runs twice on one worktree. Where a rule's `to` is not
// the product name, the summary prints the real target.
//
// Usage:
//   node custom/branding/apply-brand.mjs --root <worktree> [--brand <brand.json>]
//        [--replacements <replacements.json>] [--write] [--check] [--strict] [--json]
// Default is --check (report only). Exit 0 on success, 1 when --check finds a
// rule whose string no longer exists in the tree or --strict is violated,
// 2 on bad invocation. Never follows symlinks, never writes outside --root.
import { copyFileSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

function fail(message) {
  console.error(`apply-brand: ${message}`)
  process.exit(2)
}

function parseArgs(argv) {
  const out = { mode: 'check', strict: false, json: false }
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--write') out.mode = 'write'
    else if (arg === '--check') out.mode = 'check'
    else if (arg === '--strict') out.strict = true
    else if (arg === '--json') out.json = true
    else if (arg === '--root') out.root = argv[++i]
    else if (arg === '--brand') out.brand = argv[++i]
    else if (arg === '--replacements') out.replacements = argv[++i]
    else fail(`unknown argument ${arg}`)
  }
  if (!out.root) fail('--root is required')
  if (!out.brand) out.brand = join(dirname(fileURLToPath(import.meta.url)), 'brand.json')
  if (!out.replacements) out.replacements = join(dirname(fileURLToPath(import.meta.url)), 'replacements.json')
  return out
}

function withinRoot(root, target) {
  const rel = relative(root, resolve(target))
  return rel !== '' && !rel.startsWith('..') && !rel.startsWith(`..${sep}`) ? rel : null
}

function walk(root, dir, exts, excludeSegments, files, seen) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) {
      if (excludeSegments.has(entry.name)) continue
      walk(root, full, exts, excludeSegments, files, seen)
      continue
    }
    if (!entry.isFile()) continue
    if (!exts.has(extname(entry.name))) continue
    if (seen.has(full)) continue
    seen.add(full)
    files.push(full)
  }
}

const args = parseArgs(process.argv)
const root = resolve(args.root)
if (!existsSync(root)) fail(`root does not exist: ${root}`)
const brand = JSON.parse(readFileSync(args.brand, 'utf8'))
const spec = JSON.parse(readFileSync(args.replacements, 'utf8'))
const excludeSegments = new Set(spec.excludeSegments ?? ['node_modules', 'dist', 'build', 'coverage'])
const exts = new Set(spec.extensions ?? ['.ts', '.tsx', '.css', '.json'])

const files = []
const seen = new Set()
for (const dir of spec.includeDirs ?? []) {
  walk(root, join(root, dir), exts, excludeSegments, files, seen)
}

const replacements = (spec.replacements ?? []).filter((r) => typeof r?.from === 'string' && r.from !== '')
const totals = { filesScanned: files.length, filesChanged: 0, replacements: 0, perString: {}, matchedPerString: {} }
for (const r of replacements) { totals.perString[r.from] = 0; totals.matchedPerString[r.from] = 0 }

/**
 * Apply one rule to one file's text. A rule may declare
 * `skipWhenPrecededBy: "<prefix>"`; an occurrence already carrying that prefix
 * counts as matched but stays untouched, which keeps a prefix rule
 * (`X -> 派诺·X`) idempotent when the transform runs twice on one worktree.
 * @param {string} text - file contents.
 * @param {{from: string, to?: unknown, skipWhenPrecededBy?: unknown}} rule - replacement rule.
 * @returns {{text: string, matched: number, applied: number}} transformed text and counts.
 */
function applyRule(text, rule) {
  const guard = typeof rule.skipWhenPrecededBy === 'string' ? rule.skipWhenPrecededBy : ''
  const to = String(rule.to ?? '')
  if (guard === '') {
    const parts = text.split(rule.from)
    return { text: parts.join(to), matched: parts.length - 1, applied: parts.length - 1 }
  }
  let out = ''
  let index = 0
  let matched = 0
  let applied = 0
  for (;;) {
    const at = text.indexOf(rule.from, index)
    if (at === -1) break
    matched += 1
    if (at >= guard.length && text.startsWith(guard, at - guard.length)) {
      out += text.slice(index, at + rule.from.length)
    } else {
      out += text.slice(index, at) + to
      applied += 1
    }
    index = at + rule.from.length
  }
  return { text: out + text.slice(index), matched, applied }
}

for (const file of files) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    continue
  }
  let next = text
  let changed = 0
  for (const r of replacements) {
    const result = applyRule(next, r)
    next = result.text
    changed += result.applied
    totals.perString[r.from] += result.applied
    totals.matchedPerString[r.from] += result.matched
  }
  if (changed === 0) continue
  totals.filesChanged += 1
  totals.replacements += changed
  if (args.mode === 'write') writeFileSync(file, next)
}

const assetResults = []
for (const asset of brand.assets ?? []) {
  const source = resolve(dirname(args.brand), asset.from)
  const targetRel = withinRoot(root, join(root, asset.to ?? ''))
  if (!targetRel) fail(`asset target escapes root: ${asset.to}`)
  const target = join(root, targetRel)
  const row = { from: asset.from, to: targetRel, sourceExists: existsSync(source), targetExists: existsSync(target) }
  if (args.mode === 'write') {
    if (!row.sourceExists) {
      // Prepared brand packs can ship platform-specific assets later; a missing
      // optional asset keeps the upstream icon (reported, not fatal). --strict
      // turns this into a hard failure so release pipelines can require a full set.
      console.warn(`apply-brand: asset missing, keeping upstream: ${source}`)
      row.skipped = true
    } else {
      writeFileSync(target, readFileSync(source))
      row.copied = true
    }
  }
  assetResults.push(row)
}

const summary = { schema: 'sdz-fork-brand-report/v1', mode: args.mode, root, productName: brand.productName, ...totals, assets: assetResults }
if (args.json) console.log(JSON.stringify(summary, null, 2))
else {
  console.log(`apply-brand[${args.mode}] root=${root}`)
  console.log(`  scanned=${totals.filesScanned} changed=${totals.filesChanged} replacements=${totals.replacements}`)
  for (const r of replacements) {
    const already = totals.matchedPerString[r.from] - totals.perString[r.from]
    const suffix = already > 0 ? ` (${already} already branded)` : ''
    console.log(`  "${r.from}" -> ${JSON.stringify(String(r.to ?? ''))} × ${totals.perString[r.from]}${suffix}`)
  }
  for (const a of assetResults) console.log(`  asset ${a.to} source=${a.sourceExists ? 'ok' : 'missing'}${args.mode === 'write' ? ` copied=${a.copied === true}` : ''}`)
}
// A rule whose string is gone from the tree brands nothing, and upstream copy
// drift is the usual cause. --check runs on the pristine checkout (CI guard and
// the post-merge sync), so it must fail loud there; --write also runs on an
// already-branded worktree, where the strings a previous pass consumed are
// expected to be absent, so it reports instead.
const stale = replacements.filter((r) => totals.matchedPerString[r.from] === 0)
if (stale.length > 0) {
  const names = stale.map((r) => JSON.stringify(r.from)).join(', ')
  const message = `brand string not found in this tree (upstream copy may have changed; update replacements.json): ${names}`
  if (args.mode === 'check') { console.error(`apply-brand: ${message}`); process.exit(1) }
  console.warn(`apply-brand: ${message}`)
}
if (args.strict) {
  const missingAssets = assetResults.filter((a) => !a.sourceExists)
  const noCopy = assetResults.filter((a) => args.mode === 'check' && !a.targetExists)
  if (missingAssets.length > 0) { console.error(`apply-brand: missing brand assets: ${missingAssets.map((a) => a.from).join(', ')}`); process.exit(1) }
  if (totals.replacements === 0) { console.error('apply-brand: no replacement matched (upstream copy may have changed; update replacements.json)'); process.exit(1) }
  if (noCopy.length > 0) console.error(`apply-brand: note: ${noCopy.length} asset target(s) absent before write`)
}
