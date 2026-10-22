#!/usr/bin/env node
/**
 * Validate one published PaiNuo Desktop update feed before a signed build points
 * at it. Signing a release makes it updatable, so the feed itself becomes
 * production input: its metadata must describe exactly the artifacts beside it,
 * and every payload URL must be a PaiNuo-hosted HTTPS object with the branded
 * artifact prefix.
 *
 * The published metadata is what `apps/desktop/scripts/desktop-upload-plan.ts`
 * writes into `<origin>/<releasePrefix>/feeds/<target>/<channel>[-mac].yml`: the
 * electron-builder metadata with `files[].url` and `path` rewritten to the
 * public object URL. This tool re-derives the same facts from the local files.
 *
 * Usage:
 *   node scripts/custom/verify-brand-update-feed.mjs --dir <feed dir> [options]
 *
 * Options:
 *   --dir <path>            Directory that will be served as the feed (required).
 *   --metadata <file>       Metadata filename; default detects one in --dir.
 *   --target <name>         mac-arm64 | mac-x64 | win-x64; default from the directory name.
 *   --channel <name>        nightly | latest; default from the metadata filename.
 *   --origin <origin>       Expected HTTPS origin of every payload URL.
 *   --version <semver>      Expected published version (default: whatever the metadata says).
 *   --allow-missing-files   Do not require each listed artifact to exist locally.
 *   --json                  Machine-readable result.
 *
 * Exit codes: 0 valid; 1 invalid or missing; 2 usage error.
 */
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as yaml from 'js-yaml'
import { valid } from 'semver'

const TARGETS = new Set(['mac-arm64', 'mac-x64', 'win-x64'])
const METADATA_NAME = /^(nightly|latest)(-mac)?\.yml$/u
const METADATA_HINT = '<nightly|latest>[-mac].yml'
const BRAND_MANIFEST = fileURLToPath(new URL('../../custom/branding/brand.json', import.meta.url))

/** Reject hosts owned by DeepSeek; a branded feed never points upstream. */
function upstreamHost(hostname) {
  const normalized = hostname.trim().toLowerCase().replace(/\.$/u, '')
  return normalized === 'deepseek.com' || normalized.endsWith('.deepseek.com')
    || normalized === 'deepseeksvc.com' || normalized.endsWith('.deepseeksvc.com')
}

/** Parse the small, dependency-free command line. */
function parseArgs(argv) {
  const options = {
    dir: undefined, metadata: undefined, target: undefined, channel: undefined,
    origin: undefined, version: undefined, allowMissingFiles: false, json: false,
  }
  const valueFlags = new Map([
    ['--dir', 'dir'], ['--metadata', 'metadata'], ['--target', 'target'],
    ['--channel', 'channel'], ['--origin', 'origin'], ['--version', 'version'],
  ])
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') return { help: true }
    if (arg === '--json') { options.json = true; continue }
    if (arg === '--allow-missing-files') { options.allowMissingFiles = true; continue }
    const [flag, inline] = arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined]
    const key = valueFlags.get(flag)
    if (key === undefined) throw usageError(`unknown argument: ${arg}`)
    const value = inline ?? argv[index + 1]
    if (value === undefined || value === '' || (inline === undefined && value.startsWith('-'))) {
      throw usageError(`missing value for ${flag}`)
    }
    if (inline === undefined) index += 1
    options[key] = value
  }
  if (options.dir === undefined) throw usageError('--dir is required')
  return options
}

function usageError(message) {
  const error = new Error(message)
  error.usage = true
  return error
}

function usage() {
  return `PaiNuo Desktop update feed validator

用法:
  node scripts/custom/verify-brand-update-feed.mjs --dir <feed 目录> [--origin https://...]

校验内容:
  - 元数据 (nightly.yml / nightly-mac.yml / latest*.yml) 可解析且 version 合法;
  - files[].url / path 都是 PaiNuo HTTPS 对象，且不以 deepseek.com 主机结尾;
  - 每个本地存在的产物其 size 与 sha512 与元数据一致;
  - 产物文件名使用品牌前缀 custom/branding/brand.json#artifactPrefix;
  - --target 与 --origin 给定时，目录名、主机必须与之一致。

退出码: 0 通过；1 校验失败或缺文件；2 用法错误。`
}

/** Compute the base64 SHA-512 electron-builder records in update metadata. */
function sha512(path) {
  return createHash('sha512').update(readFileSync(path)).digest('base64')
}

function selectMetadata(options) {
  const entries = readdirSync(options.dir).filter(name => METADATA_NAME.test(name)).sort()
  if (options.metadata !== undefined) return options.metadata
  if (entries.length !== 1) {
    throw new Error(entries.length === 0
      ? `no ${METADATA_HINT} metadata in ${options.dir}`
      : `several metadata files in ${options.dir}; pass --metadata`)
  }
  return entries[0]
}

/**
 * Validate one feed directory.
 * @param {{ dir: string, metadata?: string, target?: string, channel?: string, origin?: string, version?: string, allowMissingFiles?: boolean }} options Feed inputs.
 * @returns {{ failures: string[], notes: string[], metadata: string, version: string }} Validation result.
 */
export function verifyBrandUpdateFeed(options) {
  const failures = []
  const notes = []
  const directory = resolve(options.dir)
  const metadataName = selectMetadata({ ...options, dir: directory })
  const match = METADATA_NAME.exec(metadataName)
  if (match === null) failures.push(`metadata filename ${metadataName} must be <nightly|latest>[-mac].yml`)
  const channel = options.channel ?? match?.[1] ?? 'nightly'
  if (options.channel !== undefined && match !== null && match[1] !== options.channel) {
    failures.push(`metadata filename ${metadataName} does not match channel ${options.channel}`)
  }
  const target = options.target ?? (TARGETS.has(basename(directory)) ? basename(directory) : undefined)
  if (options.target !== undefined && !TARGETS.has(options.target)) {
    failures.push(`target ${JSON.stringify(options.target)} is not a supported release target`)
  }
  const macMetadata = metadataName.includes('-mac')
  if (target !== undefined && TARGETS.has(target) && (target.startsWith('mac-') !== macMetadata)) {
    failures.push(`metadata ${metadataName} does not match target ${target}`)
  }

  const metadataPath = join(directory, metadataName)
  let parsed
  let text
  try {
    text = readFileSync(metadataPath, 'utf8')
    parsed = yaml.load(text)
  } catch (error) {
    return { failures: [...failures, `cannot read ${metadataPath}: ${error instanceof Error ? error.message : String(error)}`], notes, metadata: metadataName, version: '' }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { failures: [...failures, `${metadataName} must parse to an object`], notes, metadata: metadataName, version: '' }
  }

  // Published metadata may name its payloads by absolute URL; a raw
  // electron-builder file is only acceptable with --allow-missing-files.
  for (const matchHost of text.matchAll(/https?:\/\/[^\s'"`)]+/gu)) {
    try {
      const host = new URL(matchHost[0]).hostname
      if (upstreamHost(host)) failures.push(`${metadataName} names upstream host ${host}`)
    } catch {
      failures.push(`${metadataName} contains an unparseable URL`)
    }
  }

  const brand = JSON.parse(readFileSync(BRAND_MANIFEST, 'utf8'))
  const prefix = typeof brand.artifactPrefix === 'string' && brand.artifactPrefix !== '' ? brand.artifactPrefix : undefined
  const version = typeof parsed.version === 'string' ? parsed.version : ''
  if (valid(version) === null) failures.push(`${metadataName}.version ${JSON.stringify(parsed.version)} is not a valid version`)
  if (options.version !== undefined && options.version !== version) {
    failures.push(`${metadataName}.version ${version} does not match expected ${options.version}`)
  }

  const files = Array.isArray(parsed.files) ? parsed.files : []
  if (files.length === 0) failures.push(`${metadataName}.files must list at least one artifact`)
  const urls = []
  for (const [index, entry] of files.entries()) {
    const label = `${metadataName}.files[${index}]`
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      failures.push(`${label} must be an object`)
      continue
    }
    const url = typeof entry.url === 'string' ? entry.url : ''
    if (url === '') {
      failures.push(`${label}.url must be a non-empty string`)
      continue
    }
    urls.push(url)
    let filename
    if (/^https?:\/\//u.test(url)) {
      let parsedUrl
      try {
        parsedUrl = new URL(url)
      } catch {
        failures.push(`${label}.url is not a valid URL`)
        continue
      }
      if (parsedUrl.protocol !== 'https:') failures.push(`${label}.url must use HTTPS`)
      if (upstreamHost(parsedUrl.hostname)) failures.push(`${label}.url names upstream host ${parsedUrl.hostname}`)
      if (options.origin !== undefined && parsedUrl.origin !== options.origin) {
        failures.push(`${label}.url origin ${parsedUrl.origin} does not match ${options.origin}`)
      }
      filename = decodeURIComponent(basename(parsedUrl.pathname))
    } else {
      filename = url
      if (url.includes('/') || url.includes('..')) failures.push(`${label}.url must be a bare filename or an absolute HTTPS URL`)
      if (options.origin !== undefined) failures.push(`${label}.url must be absolute once published`)
      notes.push(`${label}.url is relative; validating the artifact beside the metadata`)
    }
    if (prefix !== undefined && filename !== '' && !filename.startsWith(`${prefix}-`)) {
      failures.push(`${label} artifact ${filename} does not use the brand artifact prefix ${prefix}-`)
    }
    const localPath = join(directory, filename)
    let details
    try {
      details = statSync(localPath)
    } catch {
      if (options.allowMissingFiles !== true) failures.push(`${label} artifact ${filename} is missing from ${directory}`)
      continue
    }
    if (!details.isFile() || details.size === 0) {
      failures.push(`${label} artifact ${filename} is empty`)
      continue
    }
    if (typeof entry.size === 'number' && entry.size !== details.size) {
      failures.push(`${label} size ${entry.size} does not match ${filename} (${details.size})`)
    }
    if (typeof entry.sha512 === 'string' && entry.sha512 !== '') {
      const actual = sha512(localPath)
      if (actual !== entry.sha512) failures.push(`${label} sha512 does not match ${filename}`)
    } else {
      failures.push(`${label}.sha512 must be a non-empty string`)
    }
  }

  if (parsed.path !== undefined) {
    if (typeof parsed.path !== 'string' || !urls.includes(parsed.path)) {
      failures.push(`${metadataName}.path must repeat one files[].url`)
    }
  }
  if (channel === 'latest' && version.includes('-')) failures.push(`${metadataName} publishes a prerelease on the latest channel`)
  notes.push(`feed: ${target}/${channel} version ${version}`)
  return { failures, notes, metadata: metadataName, version }
}

function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`verify-brand-update-feed: ${error.message}\n`)
    process.exitCode = 2
    return
  }
  if (options.help === true) {
    process.stdout.write(`${usage()}\n`)
    process.exitCode = 0
    return
  }
  let result
  try {
    result = verifyBrandUpdateFeed(options)
  } catch (error) {
    process.stderr.write(`verify-brand-update-feed: FAIL: ${error.message}\n`)
    process.exitCode = 1
    return
  }
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } else {
    for (const note of result.notes) process.stdout.write(`verify-brand-update-feed: ${note}\n`)
    for (const failure of result.failures) process.stderr.write(`verify-brand-update-feed: FAIL: ${failure}\n`)
  }
  if (result.failures.length > 0) {
    if (!options.json) process.stderr.write(`verify-brand-update-feed: FAILED (${result.failures.length})\n`)
    process.exitCode = 1
    return
  }
  if (!options.json) process.stdout.write('verify-brand-update-feed: PASS\n')
  process.exitCode = 0
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()