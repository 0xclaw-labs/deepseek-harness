#!/usr/bin/env node
// Patch the packaged terminal launchers for a rebranded build.
//
// Upstream's launchers hardcode the upstream executable name ("DeepSeek
// Harness") and leave DSH_HOME unset, so a branded `dsh` command would either
// fail to find its binary or read the user's upstream `~/.dsh`. This transform
// runs on a build worktree, after apply-brand.mjs and before packaging.
//
// Usage:
//   node custom/branding/patch-cli.mjs --root <worktree> [--brand <brand.json>]
//        [--write] [--check]
// Default is --check (report only). Exit 0 on success, 1 when a check fails,
// 2 on bad invocation.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

function fail(message, code = 2) {
  console.error(`patch-cli: ${message}`)
  process.exit(code)
}

function parseArgs(argv) {
  const out = { mode: 'check', root: undefined, brand: undefined }
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--write') out.mode = 'write'
    else if (arg === '--check') out.mode = 'check'
    else if (arg === '--root') out.root = argv[++i]
    else if (arg === '--brand') out.brand = argv[++i]
    else fail(`unknown argument ${arg}`)
  }
  if (!out.root) fail('--root is required')
  if (!out.brand) out.brand = join(dirname(fileURLToPath(import.meta.url)), 'brand.json')
  return out
}

const args = parseArgs(process.argv)
const root = resolve(args.root)
if (!existsSync(root)) fail(`root does not exist: ${root}`)
const brand = JSON.parse(readFileSync(args.brand, 'utf8'))
if (typeof brand.productName !== 'string' || brand.productName.trim() === '') fail('brand.productName is missing')
if (typeof brand.appId !== 'string' || brand.appId.trim() === '') fail('brand.appId is missing')
const productName = brand.productName.trim()
const appId = brand.appId.trim()

const POSIX_MARKER = '# Brand isolation: the installed command boots the branded Harness home.'
const WINDOWS_MARKER = 'rem Brand isolation: the installed command boots the branded Harness home.'

/** Brand the POSIX launcher. */
function patchPosix(text) {
  const branded = text.split('DeepSeek Harness').join(productName)
  if (branded.includes(POSIX_MARKER)) return branded
  const block = [
    POSIX_MARKER,
    'if [ -n "${DSH_DESKTOP_DSH_HOME:-}" ]; then',
    '  DSH_HOME=$DSH_DESKTOP_DSH_HOME',
    'else',
    `  DSH_HOME="\${HOME}/Library/Application Support/${appId}/dsh-home"`,
    'fi',
    'export DSH_HOME',
    `DSH_AGENTS_HOME="\${HOME}/Library/Application Support/${appId}/agents-home"`,
    'export DSH_AGENTS_HOME',
    'unset DSH_PROFILE DSH_PROFILE_DIR DSH_SESSION_ID DSH_WEB_URL DSH_SHELL',
    '',
  ].join('\n')
  const anchor = 'ELECTRON_RUN_AS_NODE=1 exec'
  if (!branded.includes(anchor)) fail('POSIX launcher anchor not found')
  return branded.replace(anchor, `${block}${anchor}`)
}

/** Brand the Windows launcher, preserving its CRLF line endings. */
function patchWindows(text) {
  const branded = text.split('DeepSeek Harness').join(productName)
  if (branded.includes(WINDOWS_MARKER)) return branded
  const block = [
    WINDOWS_MARKER,
    `if defined DSH_DESKTOP_DSH_HOME (set "DSH_HOME=%DSH_DESKTOP_DSH_HOME%") else (set "DSH_HOME=%APPDATA%\\${appId}\\dsh-home")`,
    `set "DSH_AGENTS_HOME=%APPDATA%\\${appId}\\agents-home"`,
    'set "DSH_PROFILE="',
    'set "DSH_PROFILE_DIR="',
    'set "DSH_SESSION_ID="',
    'set "DSH_WEB_URL="',
    'set "DSH_SHELL="',
    '',
  ].join('\r\n')
  const anchor = '"%~dp0..\\..\\..\\..\\'
  const index = branded.indexOf(anchor)
  if (index < 0) fail('Windows launcher anchor not found')
  return `${branded.slice(0, index)}${block}${branded.slice(index)}`
}

const targets = [
  { name: 'dsh', expected: (text) => text.includes(`${appId}/dsh-home`) && text.includes('export DSH_HOME') },
  { name: 'dsh.cmd', expected: (text) => text.includes(`${appId}\\dsh-home`) && text.includes('set "DSH_HOME=') },
]
const report = []
let failed = false
for (const target of targets) {
  const path = join(root, 'apps', 'desktop', 'cli', target.name)
  if (!existsSync(path)) {
    report.push({ file: target.name, status: 'missing' })
    failed = true
    continue
  }
  const original = readFileSync(path, 'utf8')
  const next = target.name === 'dsh' ? patchPosix(original) : patchWindows(original)
  if (args.mode === 'write') {
    if (next !== original) writeFileSync(path, next)
    report.push({ file: target.name, status: next === original ? 'unchanged' : 'written' })
  } else {
    const valid = next === original
      && !next.includes('DeepSeek Harness')
      && next.includes(productName)
      && target.expected(next)
    report.push({ file: target.name, status: valid ? 'ok' : 'stale' })
    if (!valid) failed = true
  }
}

for (const row of report) console.log(`patch-cli: ${row.file} ${row.status}`)
if (report.some(row => row.status === 'missing')) fail('launcher file is missing', 1)
if (args.mode === 'check' && failed) fail('launcher is not branded; run with --write in the build worktree', 1)
if (args.mode === 'check') console.log(`patch-cli: PASS (${productName} / ${appId})`)
