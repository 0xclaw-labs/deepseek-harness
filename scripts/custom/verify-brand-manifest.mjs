#!/usr/bin/env node
// Verify that an unsigned build's packaged identity is the brand, not upstream.
// A build that silently falls back to upstream's appId/userData/scheme shares
// Chromium state and the dsh:// handler with an installed DeepSeek Harness.
//
// Usage: node scripts/custom/verify-brand-manifest.mjs <build-worktree> [artifact-dir]
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

const worktree = process.argv[2]
if (!worktree) { console.error('verify-brand-manifest: missing worktree argument'); process.exit(2) }
const brand = JSON.parse(readFileSync(new URL('../../custom/branding/brand.json', import.meta.url), 'utf8'))
const desktop = join(worktree, 'apps', 'desktop')
const artifactsRoot = process.argv[3] ?? join(desktop, '.desktop-build', 'targets', 'mac-arm64', 'unsigned-artifacts')
const appName = `${brand.productName}.app`
const appPath = join(artifactsRoot, appName)
if (!existsSync(appPath)) { console.error(`verify-brand-manifest: app not found: ${appPath}`); process.exit(1) }
const asarPath = join(appPath, 'Contents', 'Resources', 'app.asar')

/** Read one file out of an asar archive without extra dependencies. */
function readAsarFile(archive, name) {
  const fd = readFileSync(archive)
  const headerSize = fd.readUInt32LE(4)
  const jsonLength = fd.readUInt32LE(12)
  const header = JSON.parse(fd.subarray(16, 16 + jsonLength).toString('utf8'))
  const dataStart = 8 + headerSize
  let node = header.files
  for (const part of name.split('/')) {
    if (node === undefined || node.files === undefined || node.files[part] === undefined) return undefined
    node = node.files[part]
  }
  if (node === undefined || node.offset === undefined) return undefined
  return fd.subarray(dataStart + Number(node.offset), dataStart + Number(node.offset) + node.size).toString('utf8')
}

const manifest = JSON.parse(readAsarFile(asarPath, 'package.json'))
const mainSource = readAsarFile(asarPath, 'lib/main.js') ?? ''
const problems = []
const expect = {
  productName: brand.productName,
  dshDesktopAppId: brand.appId,
  dshDesktopProfileDirectory: brand.appId,
  dshDesktopProtocolScheme: brand.protocolScheme,
}
for (const [key, value] of Object.entries(expect)) {
  if (manifest[key] !== value) problems.push(`manifest.${key}=${JSON.stringify(manifest[key])} expected ${JSON.stringify(value)}`)
}
if (manifest.dshDesktopAppId === 'com.deepseek.harness') problems.push('manifest still carries upstream appId')
if (!mainSource.includes('dsh-home')) problems.push('lib/main.js has no private dsh-home bootstrap')
const plist = execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', join(appPath, 'Contents', 'Info.plist')], { encoding: 'utf8' })
const info = JSON.parse(plist)
if (info.CFBundleIdentifier !== brand.appId) problems.push(`CFBundleIdentifier=${JSON.stringify(info.CFBundleIdentifier)} expected ${JSON.stringify(brand.appId)}`)
const schemes = (info.CFBundleURLTypes ?? []).flatMap(entry => entry.CFBundleURLSchemes ?? [])
if (!schemes.includes(brand.protocolScheme)) problems.push(`CFBundleURLSchemes missing ${brand.protocolScheme} (got ${JSON.stringify(schemes)})`)
if (schemes.includes('dsh')) problems.push('bundle still declares upstream dsh:// scheme')

if (problems.length > 0) {
  console.error('verify-brand-manifest: FAILED')
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}
console.log(`verify-brand-manifest: PASS (${brand.productName} / ${brand.appId} / ${brand.protocolScheme})`)
