/**
 * Unit tests for verify-brand-update-feed.mjs.
 *
 * Every fixture is a throwaway directory: no real release feed, artifact, or
 * configured origin is touched. Run with:
 *   node --test scripts/custom/tests/verify-brand-update-feed.test.mjs
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import * as yaml from 'js-yaml'
import { verifyBrandUpdateFeed } from '../verify-brand-update-feed.mjs'

const ORIGIN = 'https://dl.modelxing.com'
const PREFIX = 'suishendazi-harness'

async function fixtureDirectory(target = 'mac-arm64') {
  const root = await mkdtemp(join(tmpdir(), 'dsh-feed-'))
  const directory = join(root, target)
  await mkdir(directory, { recursive: true })
  return { root, directory }
}

function sha512(buffer) {
  return createHash('sha512').update(buffer).digest('base64')
}

async function publishedFeed(options = {}) {
  const { directory } = await fixtureDirectory(options.target ?? 'mac-arm64')
  const version = options.version ?? '0.2.3'
  const filename = `${PREFIX}-${version}-mac-arm64.zip`
  const payload = Buffer.from('branded updater payload')
  await writeFile(join(directory, filename), payload)
  const metadata = {
    version,
    files: [{
      url: `${options.origin ?? ORIGIN}/suishendazi-desk/bin/mac-arm64/${filename}`,
      sha512: options.sha512 ?? sha512(payload),
      size: options.size ?? payload.length,
    }],
    path: `${options.origin ?? ORIGIN}/suishendazi-desk/bin/mac-arm64/${filename}`,
    releaseDate: '2026-10-22T00:00:00.000Z',
  }
  await writeFile(join(directory, `${options.channel ?? 'nightly'}-mac.yml`), yaml.dump(options.rawMetadata ?? metadata))
  return { directory, filename, payload }
}

test('accepts one published branded feed and re-derives its hashes', async () => {
  const { directory, filename } = await publishedFeed()
  const result = verifyBrandUpdateFeed({ dir: directory, target: 'mac-arm64', origin: ORIGIN, version: '0.2.3' })
  assert.deepEqual(result.failures, [])
  assert.equal(result.metadata, 'nightly-mac.yml')
  assert.match(result.notes.join('\n'), /mac-arm64\/nightly version 0\.2\.3/u)
  assert.match(filename, /^suishendazi-harness-/u)
  await rm(directory, { recursive: true, force: true })
})

test('rejects an upstream host, a wrong origin, and a non-HTTPS payload', async () => {
  const upstream = await publishedFeed({ origin: 'https://download.deepseek.com' })
  const upstreamResult = verifyBrandUpdateFeed({ dir: upstream.directory, origin: ORIGIN })
  assert.ok(upstreamResult.failures.some(failure => failure.includes('upstream host download.deepseek.com')))
  await rm(upstream.directory, { recursive: true, force: true })

  const other = await publishedFeed({ origin: 'https://cdn.example.com' })
  const otherResult = verifyBrandUpdateFeed({ dir: other.directory, origin: ORIGIN })
  assert.ok(otherResult.failures.some(failure => failure.includes('does not match https://dl.modelxing.com')))
  await rm(other.directory, { recursive: true, force: true })

  const insecure = await publishedFeed({ origin: 'http://dl.modelxing.com' })
  const insecureResult = verifyBrandUpdateFeed({ dir: insecure.directory })
  assert.ok(insecureResult.failures.some(failure => failure.includes('must use HTTPS')))
  await rm(insecure.directory, { recursive: true, force: true })
})

test('rejects a hash or size that does not describe the artifact beside it', async () => {
  const wrongHash = await publishedFeed({ sha512: sha512(Buffer.from('different bytes')) })
  const hashResult = verifyBrandUpdateFeed({ dir: wrongHash.directory })
  assert.ok(hashResult.failures.some(failure => failure.includes('sha512 does not match')))
  await rm(wrongHash.directory, { recursive: true, force: true })

  const wrongSize = await publishedFeed({ size: 1 })
  const sizeResult = verifyBrandUpdateFeed({ dir: wrongSize.directory })
  assert.ok(sizeResult.failures.some(failure => failure.includes('does not match suishendazi-harness')))
  await rm(wrongSize.directory, { recursive: true, force: true })
})

test('rejects an artifact that does not use the brand prefix and a missing artifact', async () => {
  const upstreamName = await publishedFeed()
  await writeFile(join(upstreamName.directory, 'nightly-mac.yml'), yaml.dump({
    version: '0.2.3',
    files: [{ url: `${ORIGIN}/dsh-desk/bin/mac-arm64/deepseek-harness-0.2.3-mac-arm64.zip`, sha512: sha512(upstreamName.payload), size: upstreamName.payload.length }],
  }))
  const nameResult = verifyBrandUpdateFeed({ dir: upstreamName.directory })
  assert.ok(nameResult.failures.some(failure => failure.includes('does not use the brand artifact prefix')))
  await rm(upstreamName.directory, { recursive: true, force: true })

  const missing = await publishedFeed()
  await rm(join(missing.directory, missing.filename))
  const missingResult = verifyBrandUpdateFeed({ dir: missing.directory })
  assert.ok(missingResult.failures.some(failure => failure.includes('is missing from')))
  assert.deepEqual(verifyBrandUpdateFeed({ dir: missing.directory, allowMissingFiles: true }).failures, [])
  await rm(missing.directory, { recursive: true, force: true })
})

test('rejects metadata that disagrees with its directory, channel, version, or path', async () => {
  const mismatched = await publishedFeed()
  const targetResult = verifyBrandUpdateFeed({ dir: mismatched.directory, target: 'win-x64' })
  assert.ok(targetResult.failures.some(failure => failure.includes('does not match target win-x64')))
  const channelResult = verifyBrandUpdateFeed({ dir: mismatched.directory, channel: 'latest' })
  assert.ok(channelResult.failures.some(failure => failure.includes('does not match channel latest')))
  const versionResult = verifyBrandUpdateFeed({ dir: mismatched.directory, version: '0.2.4' })
  assert.ok(versionResult.failures.some(failure => failure.includes('does not match expected 0.2.4')))
  await rm(mismatched.directory, { recursive: true, force: true })

  const invalid = await publishedFeed({ version: 'latest' })
  const invalidResult = verifyBrandUpdateFeed({ dir: invalid.directory })
  assert.ok(invalidResult.failures.some(failure => failure.includes('is not a valid version')))
  await rm(invalid.directory, { recursive: true, force: true })

  const brokenPath = await publishedFeed()
  const metadata = yaml.load(await readFile(join(brokenPath.directory, 'nightly-mac.yml'), 'utf8'))
  metadata.path = `${ORIGIN}/other/object.zip`
  await writeFile(join(brokenPath.directory, 'nightly-mac.yml'), yaml.dump(metadata))
  const brokenPathResult = verifyBrandUpdateFeed({ dir: brokenPath.directory })
  assert.ok(brokenPathResult.failures.some(failure => failure.includes('.path must repeat one files[].url')))
  await rm(brokenPath.directory, { recursive: true, force: true })
})

test('rejects a prerelease published on the latest channel and an ambiguous directory', async () => {
  const prerelease = await publishedFeed({ channel: 'latest', version: '0.2.3-rc.1' })
  const prereleaseResult = verifyBrandUpdateFeed({ dir: prerelease.directory })
  assert.ok(prereleaseResult.failures.some(failure => failure.includes('prerelease on the latest channel')))
  await rm(prerelease.directory, { recursive: true, force: true })

  const empty = await fixtureDirectory('mac-arm64')
  assert.throws(() => verifyBrandUpdateFeed({ dir: empty.directory }), /no <nightly|latest>\[-mac\]\.yml metadata in/u)
  await rm(empty.root, { recursive: true, force: true })

  const ambiguous = await publishedFeed()
  await writeFile(join(ambiguous.directory, 'latest-mac.yml'), yaml.dump({ version: '0.2.3', files: [] }))
  assert.throws(() => verifyBrandUpdateFeed({ dir: ambiguous.directory }), /several metadata files/u)
  await rm(ambiguous.directory, { recursive: true, force: true })
})

test('accepts relative electron-builder metadata only against local artifacts', async () => {
  const { directory, filename, payload } = await publishedFeed()
  await writeFile(join(directory, 'nightly-mac.yml'), yaml.dump({
    version: '0.2.3',
    files: [{ url: filename, sha512: sha512(payload), size: payload.length }],
    path: filename,
  }))
  const relative = verifyBrandUpdateFeed({ dir: directory })
  assert.deepEqual(relative.failures, [])
  assert.match(relative.notes.join('\n'), /is relative/u)
  const published = verifyBrandUpdateFeed({ dir: directory, origin: ORIGIN })
  assert.ok(published.failures.some(failure => failure.includes('must be absolute once published')))
  await rm(directory, { recursive: true, force: true })
})