/**
 * Fake-HOME golden tests for migrate-brand-profile.mjs.
 *
 * Every fixture is a throwaway HOME: no real brand profile, official ~/.dsh,
 * Documents folder or running desktop app is touched. Run with:
 *   node --test scripts/custom/tests/migrate-brand-profile.test.mjs
 */
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const runFile = promisify(execFile)
const SCRIPT = fileURLToPath(new URL('../migrate-brand-profile.mjs', import.meta.url))
const APP_ID = 'cc.suishendazi.app'
const OLD = 'Documents/deepseek-harness/default-workspace'
const TARGET = 'Documents/随身搭子/default-workspace'

function projectKey(cwd) {
  let readable = ''
  let separatorRun = false
  for (let index = 0; index < cwd.length; index += 1) {
    const code = cwd.charCodeAt(index)
    const char = String.fromCharCode(code)
    if (char === '/' || char === '\\' || char === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (char !== '~' && /^[A-Za-z0-9._-]$/.test(char)) {
      readable += char
      separatorRun = false
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

async function hashFile(path) {
  const hash = createHash('sha256')
  hash.update(await readFile(path))
  return hash.digest('hex')
}

async function snapshot(root) {
  const entries = []
  async function walk(directory, prefix) {
    let children
    try { children = await readdir(directory, { withFileTypes: true }) } catch { return }
    for (const child of children.sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, child.name)
      const rel = prefix === '' ? child.name : `${prefix}/${child.name}`
      const info = await lstat(path)
      if (info.isSymbolicLink()) {
        entries.push(`${rel}|link|${await readFile(path).catch(() => '')}`)
      } else if (info.isDirectory()) {
        entries.push(`${rel}|dir|${info.mode & 0o777}`)
        await walk(path, rel)
      } else {
        entries.push(`${rel}|file|${info.size}|${info.mode & 0o777}|${await hashFile(path)}`)
      }
    }
  }
  await walk(root, '')
  return entries
}

async function writeText(path, text, mode = 0o600) {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, text, { mode })
  await chmod(path, mode)
}

async function makeFixture(options = {}) {
  const {
    hasSessions = true,
    registry = true,
    official = true,
    conflict = false,
    version = 2,
    patch = true,
  } = options
  const home = await mkdtemp(join(tmpdir(), 'dsh-migrate-golden-'))
  const profile = join(home, 'Library', 'Application Support', APP_ID)
  const dshHome = join(profile, 'dsh-home')
  const oldPath = join(home, OLD)
  const targetPath = join(home, TARGET)
  const patchPath = join(dshHome, 'profiles', 'desktop', 'cordis.patch.yml')
  const registryPath = join(dshHome, 'storages', 'workspace.json')
  const officialHome = join(home, '.dsh')
  const officialRegistry = join(officialHome, 'storages', 'workspace.json')
  const workspaceId = '11111111-1111-4111-8111-111111111111'
  const sessionId = 'session-golden-0001'

  await mkdir(join(dshHome, 'storages'), { recursive: true })
  await mkdir(join(dshHome, 'profiles', 'desktop'), { recursive: true })
  await mkdir(join(dshHome, 'attachments', 'v1'), { recursive: true })
  await mkdir(join(dshHome, 'storages', 'session_projcache', 'sessions'), { recursive: true })
  await writeText(join(dshHome, '.credentials.yaml'), 'version: 1\nrecords: {}\n')
  await writeText(join(dshHome, '.anonymous-user-id'), 'golden-anon\n')
  await writeText(join(dshHome, 'attachments', 'v1', 'upload.txt'), 'attachment-content\n')
  await writeText(join(dshHome, 'storages', 'session_projcache', 'sessions', `${sessionId}.json`), '{}\n')

  if (hasSessions) {
    const sessionDir = join(dshHome, 'sessions', projectKey(oldPath), sessionId)
    await mkdir(sessionDir, { recursive: true })
    await writeText(join(sessionDir, 'session.v4.jsonl.zstd'), `{"type":"session","id":"${sessionId}"}\n`)
    await writeText(join(sessionDir, 'session.lock'), '')
  }

  await mkdir(join(oldPath, 'nested'), { recursive: true })
  await writeText(join(oldPath, 'notes.txt'), 'shared notes\n', 0o644)
  await writeText(join(oldPath, 'nested', 'data.json'), '{"ok":true}\n', 0o644)
  await writeText(join(oldPath, '.hidden'), 'hidden file\n', 0o600)
  await writeText(join(oldPath, 'image.bin'), Buffer.from([0, 1, 2, 3, 255]), 0o644)

  if (patch) {
    await writeText(patchPath, `# brand-default-workspace: fixture\n- id: workspace-controller\n  config:\n    defaultWorkspacePath: ${JSON.stringify(oldPath)}\n- id: llm-pi-ai\n  config:\n    providers:\n      painuo:\n        displayName: 派诺生态\n        baseURL: https://auth.modelxing.com/pi/v1\n`)
  }

  if (registry) {
    await writeText(registryPath, `${JSON.stringify({
      unit: { name: 'workspace', version },
      global: {
        initialized: version === 2,
        workspaceIds: [workspaceId],
        archivedSessionIds: [],
        pinnedSessionIds: [],
        defaultWorkspaceId: workspaceId,
      },
      tables: {
        workspaces: {
          [workspaceId]: {
            path: oldPath,
            title: 'default-workspace',
            sessionIds: hasSessions ? [sessionId] : [],
            createdAt: '2026-10-22T00:00:00.000Z',
            updatedAt: '2026-10-22T00:00:00.000Z',
          },
        },
      },
    }, undefined, 2)}\n`)
  }

  if (official) {
    await writeText(officialRegistry, `${JSON.stringify({
      unit: { name: 'workspace', version: 2 },
      global: { initialized: true, workspaceIds: ['official-ws'], archivedSessionIds: [], pinnedSessionIds: [] },
      tables: { workspaces: { 'official-ws': {
        path: oldPath, title: 'default-workspace', sessionIds: [], createdAt: '2026-10-22T00:00:00.000Z', updatedAt: '2026-10-22T00:00:00.000Z',
      } } },
    }, undefined, 2)}\n`)
  }

  if (conflict) {
    await mkdir(targetPath, { recursive: true })
    await writeText(join(targetPath, 'notes.txt'), 'target-original\n', 0o644)
  }

  const backupRoot = join(home, 'Library', 'Application Support', `${APP_ID}.migration-backups`)
  return {
    home,
    profile,
    dshHome,
    oldPath,
    targetPath,
    patchPath,
    registryPath,
    officialRegistry,
    backupRoot,
    workspaceId,
    sessionId,
    sessionFile: join(dshHome, 'sessions', projectKey(oldPath), sessionId, 'session.v4.jsonl.zstd'),
    credentials: join(dshHome, '.credentials.yaml'),
  }
}

async function cleanup(fixture) {
  await rm(fixture.home, { recursive: true, force: true })
}

async function run(fixture, args, timeout = 30_000) {
  try {
    const result = await runFile(process.execPath, [SCRIPT, '--home', fixture.home, ...args], {
      maxBuffer: 32 * 1024 * 1024,
      timeout,
      encoding: 'utf8',
    })
    return { code: 0, ...result }
  } catch (error) {
    return {
      code: typeof error.code === 'number' ? error.code : 1,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
      signal: error.signal,
    }
  }
}

function json(result) {
  try {
    return JSON.parse(result.stdout)
  } catch (error) {
    throw new Error(`expected JSON stdout, got:\n${result.stdout}\n--- stderr ---\n${result.stderr}\n${error.message}`)
  }
}

async function backupDirs(fixture) {
  try {
    const entries = await readdir(fixture.backupRoot, { withFileTypes: true })
    return entries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

async function readRegistry(fixture) {
  return JSON.parse(await readFile(fixture.registryPath, 'utf8'))
}

async function spawnMarker(args) {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)', ...args], {
    stdio: 'ignore',
    detached: false,
  })
  await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('spawn', resolve)
  })
  await new Promise(resolve => setTimeout(resolve, 150))
  return child
}

test('dry-run migrate writes nothing and reports the safe plan', async () => {
  const fixture = await makeFixture()
  try {
    const before = await snapshot(fixture.home)
    const result = await run(fixture, ['--mode', 'migrate', '--json'])
    assert.equal(result.code, 0, result.stderr)
    const output = json(result)
    assert.equal(output.dryRun, true)
    assert.equal(output.plan.blocked.length, 0)
    assert.equal(output.plan.registryChange.kind, 'add-new-default')
    assert.equal(output.plan.registryChange.keptOldWorkspace, true)
    assert.equal(output.plan.copy.kind, 'copy')
    assert.equal(output.plan.copy.files, 4)
    assert.equal(output.plan.patch.changed, true)
    assert.equal(output.state.official.referencesSource.length, 1)
    const after = await snapshot(fixture.home)
    assert.deepEqual(after, before, 'dry-run must not change any file')
    await assert.rejects(lstat(fixture.targetPath), { code: 'ENOENT' })
    assert.deepEqual(await backupDirs(fixture), [])
  } finally {
    await cleanup(fixture)
  }
})

test('apply migrate copies files, keeps old workspace/sessions and backs up privately', async () => {
  const fixture = await makeFixture()
  try {
    const oldSessionHash = await hashFile(fixture.sessionFile)
    const credentialsHash = await hashFile(fixture.credentials)
    const oldPathSnapshot = await snapshot(fixture.oldPath)
    const officialBefore = await readFile(fixture.officialRegistry, 'utf8')

    const result = await run(fixture, ['--mode', 'migrate', '--apply', '--verify', 'hash', '--json'])
    assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`)
    const output = json(result)
    assert.equal(output.result.ok, true)
    assert.equal(output.result.registryChange, 'add-new-default')
    assert.equal(output.result.copied.conflicts, 0)

    assert.equal(await readFile(join(fixture.targetPath, 'notes.txt'), 'utf8'), 'shared notes\n')
    assert.equal(await readFile(join(fixture.targetPath, 'nested', 'data.json'), 'utf8'), '{"ok":true}\n')
    assert.equal(await readFile(join(fixture.targetPath, '.hidden'), 'utf8'), 'hidden file\n')
    assert.deepEqual(await snapshot(fixture.oldPath), oldPathSnapshot, 'source workspace must be untouched')
    assert.equal(await readFile(fixture.officialRegistry, 'utf8'), officialBefore, 'official registry must be untouched')
    assert.equal(await hashFile(fixture.sessionFile), oldSessionHash, 'session log must be untouched')
    assert.equal(await hashFile(fixture.credentials), credentialsHash, 'credentials must be untouched')

    const registry = await readRegistry(fixture)
    const oldRecord = registry.tables.workspaces[fixture.workspaceId]
    assert.equal(oldRecord.path, fixture.oldPath)
    assert.deepEqual(oldRecord.sessionIds, [fixture.sessionId])
    const newId = registry.global.defaultWorkspaceId
    assert.notEqual(newId, fixture.workspaceId)
    const newRecord = registry.tables.workspaces[newId]
    assert.equal(newRecord.path, await realpath(fixture.targetPath))
    assert.deepEqual(newRecord.sessionIds, [])
    assert.equal(registry.global.workspaceIds.length, 2)

    const patch = await readFile(fixture.patchPath, 'utf8')
    assert.match(patch, new RegExp(`defaultWorkspacePath: ${JSON.stringify(fixture.targetPath).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
    assert.match(patch, /llm-pi-ai/)
    assert.match(patch, /auth\.modelxing\.com/)

    const backups = await backupDirs(fixture)
    assert.equal(backups.length, 1)
    const backup = join(fixture.backupRoot, backups[0])
    const backupStat = await stat(backup)
    assert.equal(backupStat.mode & 0o077, 0, 'backup directory must not be group/other accessible')
    const manifest = JSON.parse(await readFile(join(backup, 'manifest.json'), 'utf8'))
    assert.equal(manifest.dshHomeBackup, 'dsh-home')
    assert.ok((await readdir(join(backup, 'dsh-home'))).includes('storages'))
    const applyLog = JSON.parse(await readFile(join(backup, 'apply-log.json'), 'utf8'))
    assert.equal(applyLog.registryChange, 'add-new-default')
    assert.ok(Array.isArray(manifest.files))
    for (const entry of manifest.files) {
      if (entry.type === 'symlink') continue
      assert.equal(entry.mode & 0o077, 0, `backup entry ${entry.path} must not be group/other accessible`)
    }
  } finally {
    await cleanup(fixture)
  }
})

test('second apply is a no-op and creates no second backup', async () => {
  const fixture = await makeFixture()
  try {
    const first = await run(fixture, ['--mode', 'migrate', '--apply', '--json'])
    assert.equal(first.code, 0, first.stderr)
    const backupsAfterFirst = await backupDirs(fixture)
    assert.equal(backupsAfterFirst.length, 1)
    const registryHash = await hashFile(fixture.registryPath)
    const patchHash = await hashFile(fixture.patchPath)

    const second = await run(fixture, ['--mode', 'migrate', '--apply', '--json'])
    assert.equal(second.code, 0, second.stderr)
    const output = json(second)
    assert.equal(output.plan.noop, true)
    assert.equal(output.plan.blocked.length, 0)
    assert.deepEqual(await backupDirs(fixture), backupsAfterFirst)
    assert.equal(await hashFile(fixture.registryPath), registryHash)
    assert.equal(await hashFile(fixture.patchPath), patchHash)
  } finally {
    await cleanup(fixture)
  }
})

test('empty old workspace is rewritten in place instead of adding a duplicate', async () => {
  const fixture = await makeFixture({ hasSessions: false })
  try {
    const result = await run(fixture, ['--mode', 'migrate', '--apply', '--json'])
    assert.equal(result.code, 0, result.stderr)
    const output = json(result)
    assert.equal(output.result.registryChange, 'rewrite-empty')
    const registry = await readRegistry(fixture)
    assert.equal(registry.global.workspaceIds.length, 1)
    assert.equal(registry.global.defaultWorkspaceId, fixture.workspaceId)
    assert.equal(registry.tables.workspaces[fixture.workspaceId].path, await realpath(fixture.targetPath))
    assert.deepEqual(registry.tables.workspaces[fixture.workspaceId].sessionIds, [])
    assert.equal(await readFile(join(fixture.targetPath, 'notes.txt'), 'utf8'), 'shared notes\n')
  } finally {
    await cleanup(fixture)
  }
})

test('reset preserves credentials, removes private data after backup, and rollback restores', async () => {
  const fixture = await makeFixture()
  try {
    const originalRegistry = await readFile(fixture.registryPath, 'utf8')
    const originalSession = await hashFile(fixture.sessionFile)
    const result = await run(fixture, ['--mode', 'reset', '--apply', '--json'])
    assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`)
    const output = json(result)
    assert.equal(output.result.ok, true)
    assert.deepEqual((await readdir(fixture.dshHome)).sort(), ['.anonymous-user-id', '.credentials.yaml'])
    await assert.rejects(lstat(fixture.registryPath), { code: 'ENOENT' })
    assert.equal((await stat(fixture.targetPath)).isDirectory(), true)
    assert.equal(await hashFile(fixture.credentials), await hashFile(join(fixture.backupRoot, (await backupDirs(fixture))[0], 'dsh-home', '.credentials.yaml')))

    // Simulate a fresh login after reset: rollback must retain it by default.
    const newCredentials = 'version: 2\nrecords: {new-login: true}\n'
    await writeText(fixture.credentials, newCredentials)
    const backups = await backupDirs(fixture)
    const rollback = await run(fixture, ['--rollback', join(fixture.backupRoot, backups[0]), '--apply', '--json'])
    assert.equal(rollback.code, 0, `${rollback.stderr}\n${rollback.stdout}`)
    assert.equal(await readFile(fixture.registryPath, 'utf8'), originalRegistry)
    assert.equal(await hashFile(fixture.sessionFile), originalSession)
    assert.equal(await readFile(fixture.credentials, 'utf8'), newCredentials)
    const rollbackOutput = json(rollback)
    assert.equal(rollbackOutput.result.ok, true)
    assert.equal(rollbackOutput.result.preservedCredentials, true)
    assert.ok(rollbackOutput.result.quarantine !== undefined)
  } finally {
    await cleanup(fixture)
  }
})

test('apply is blocked while the brand app or official app is running', async () => {
  const fixture = await makeFixture()
  let brandMarker
  let officialMarker
  try {
    brandMarker = await spawnMarker([join(fixture.dshHome, 'profiles', 'desktop')])
    const brandRun = await run(fixture, ['--mode', 'migrate', '--apply', '--json'])
    assert.equal(brandRun.code, 1)
    const brandOutput = json(brandRun)
    assert.ok(brandOutput.plan.blocked.some(reason => reason.includes('随身搭子仍在运行')))
    assert.deepEqual(await backupDirs(fixture), [])
    brandMarker.kill()
    await new Promise(resolve => brandMarker.once('exit', resolve))

    officialMarker = await spawnMarker([join(fixture.home, '.dsh', 'profiles', 'desktop')])
    const officialRun = await run(fixture, ['--mode', 'migrate', '--apply', '--json'])
    assert.equal(officialRun.code, 1)
    const officialOutput = json(officialRun)
    assert.ok(officialOutput.plan.blocked.some(reason => reason.includes('官方 DeepSeek Harness 仍在运行')))
    assert.deepEqual(await backupDirs(fixture), [])
  } finally {
    if (brandMarker !== undefined) brandMarker.kill()
    if (officialMarker !== undefined) officialMarker.kill()
    await cleanup(fixture)
  }
})

test('target conflicts are skipped, never overwritten', async () => {
  const fixture = await makeFixture({ conflict: true })
  try {
    const result = await run(fixture, ['--mode', 'migrate', '--apply', '--json'])
    assert.equal(result.code, 0, result.stderr)
    const output = json(result)
    assert.ok(output.result.copied.conflicts >= 1)
    assert.equal(await readFile(join(fixture.targetPath, 'notes.txt'), 'utf8'), 'target-original\n')
    assert.equal(await readFile(join(fixture.targetPath, 'nested', 'data.json'), 'utf8'), '{"ok":true}\n')
  } finally {
    await cleanup(fixture)
  }
})

test('--no-copy switches the default workspace without copying shared files', async () => {
  const fixture = await makeFixture()
  try {
    const result = await run(fixture, ['--mode', 'migrate', '--apply', '--no-copy', '--json'])
    assert.equal(result.code, 0, result.stderr)
    const output = json(result)
    assert.equal(output.plan.copy.kind, 'none')
    const registry = await readRegistry(fixture)
    assert.notEqual(registry.global.defaultWorkspaceId, fixture.workspaceId)
    assert.deepEqual(await readdir(fixture.targetPath), [])
  } finally {
    await cleanup(fixture)
  }
})


test('dry-run reset and dry-run rollback write nothing', async () => {
  const fixture = await makeFixture()
  try {
    const before = await snapshot(fixture.home)
    const reset = await run(fixture, ['--mode', 'reset', '--json'])
    assert.equal(reset.code, 0, reset.stderr)
    assert.equal(json(reset).plan.blocked.length, 0)
    assert.deepEqual(await snapshot(fixture.home), before)
    assert.deepEqual(await backupDirs(fixture), [])

    const applied = await run(fixture, ['--mode', 'migrate', '--apply', '--json'])
    assert.equal(applied.code, 0, applied.stderr)
    const backups = await backupDirs(fixture)
    assert.equal(backups.length, 1)
    const afterMigrate = await snapshot(fixture.home)
    const rollback = await run(fixture, ['--rollback', join(fixture.backupRoot, backups[0]), '--json'])
    assert.equal(rollback.code, 0, rollback.stderr)
    assert.equal(json(rollback).dryRun, true)
    assert.deepEqual(await snapshot(fixture.home), afterMigrate)
    assert.equal((await backupDirs(fixture)).length, 1)
  } finally {
    await cleanup(fixture)
  }
})

test('symlinks are copied as links, never dereferenced', async () => {
  const fixture = await makeFixture()
  try {
    await symlink('notes.txt', join(fixture.oldPath, 'link-to-notes'))
    const result = await run(fixture, ['--mode', 'migrate', '--apply', '--verify', 'hash', '--json'])
    assert.equal(result.code, 0, result.stderr)
    const copiedLink = join(fixture.targetPath, 'link-to-notes')
    assert.equal((await lstat(copiedLink)).isSymbolicLink(), true)
    assert.equal(await readlink(copiedLink), 'notes.txt')
    assert.equal(await readFile(copiedLink, 'utf8'), 'shared notes\n')
  } finally {
    await cleanup(fixture)
  }
})


test('rollback after migrate restores the old registry while target files remain', async () => {
  const fixture = await makeFixture()
  try {
    const originalRegistry = await readFile(fixture.registryPath, 'utf8')
    const originalPatch = await readFile(fixture.patchPath, 'utf8')
    const applied = await run(fixture, ['--mode', 'migrate', '--apply', '--json'])
    assert.equal(applied.code, 0, applied.stderr)
    const backups = await backupDirs(fixture)
    assert.equal(backups.length, 1)
    const rollback = await run(fixture, ['--rollback', join(fixture.backupRoot, backups[0]), '--apply', '--json'])
    assert.equal(rollback.code, 0, `${rollback.stderr}\n${rollback.stdout}`)
    assert.equal(await readFile(fixture.registryPath, 'utf8'), originalRegistry)
    assert.equal(await readFile(fixture.patchPath, 'utf8'), originalPatch)
    assert.equal(await readFile(join(fixture.targetPath, 'notes.txt'), 'utf8'), 'shared notes\n')
    const output = json(rollback)
    assert.equal(output.result.ok, true)
    assert.ok((await lstat(output.result.quarantine)).isDirectory())
  } finally {
    await cleanup(fixture)
  }
})


test('a failed reset backup restores the original dsh-home', async () => {
  const fixture = await makeFixture()
  try {
    const originalRegistry = await readFile(fixture.registryPath, 'utf8')
    await chmod(fixture.sessionFile, 0o000)
    const result = await run(fixture, ['--mode', 'reset', '--apply', '--json'])
    assert.equal(result.code, 1)
    assert.match(result.stderr, /EACCES|permission denied|failed/i)
    assert.equal(await readFile(fixture.registryPath, 'utf8'), originalRegistry)
    assert.deepEqual(await backupDirs(fixture), [])
  } finally {
    await chmod(fixture.sessionFile, 0o600).catch(() => {})
    await cleanup(fixture)
  }
})

test('newer registry version is refused before any write', async () => {
  const fixture = await makeFixture({ version: 3 })
  try {
    const result = await run(fixture, ['--mode', 'migrate', '--apply', '--json'])
    assert.equal(result.code, 1)
    const output = json(result)
    assert.ok(output.plan.blocked.some(reason => reason.includes('version')))
    assert.deepEqual(await backupDirs(fixture), [])
    await assert.rejects(lstat(fixture.targetPath), { code: 'ENOENT' })
  } finally {
    await cleanup(fixture)
  }
})

test('missing registry with existing sessions is refused', async () => {
  const fixture = await makeFixture({ registry: false })
  try {
    const result = await run(fixture, ['--mode', 'migrate', '--apply', '--json'])
    assert.equal(result.code, 1)
    const output = json(result)
    assert.ok(output.plan.blocked.some(reason => reason.includes('workspace.json 缺失')))
    assert.deepEqual(await backupDirs(fixture), [])
  } finally {
    await cleanup(fixture)
  }
})

async function realpath(path) {
  const { realpath: resolve } = await import('node:fs/promises')
  return await resolve(path)
}
