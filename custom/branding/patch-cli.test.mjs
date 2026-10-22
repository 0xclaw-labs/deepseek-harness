import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const repo = fileURLToPath(new URL('../..', import.meta.url))
const script = join(here, 'patch-cli.mjs')
const brand = join(here, 'brand.json')

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-patch-cli-'))
  cpSync(join(repo, 'apps', 'desktop', 'cli'), join(root, 'apps', 'desktop', 'cli'), { recursive: true })
  return root
}

test('brands both launchers and is idempotent', () => {
  const root = fixture()
  try {
    execFileSync(process.execPath, [script, '--root', root, '--brand', brand, '--write'], { stdio: 'pipe' })
    const posix = readFileSync(join(root, 'apps', 'desktop', 'cli', 'dsh'), 'utf8')
    const windows = readFileSync(join(root, 'apps', 'desktop', 'cli', 'dsh.cmd'), 'utf8')
    for (const text of [posix, windows]) {
      assert.doesNotMatch(text, /DeepSeek Harness/)
      assert.match(text, /随身搭子/)
      assert.match(text, /cc\.suishendazi\.app[\\/]dsh-home/)
    }
    assert.match(posix, /export DSH_HOME/)
    assert.match(windows, /set "DSH_HOME=/)
    execFileSync(process.execPath, [script, '--root', root, '--brand', brand, '--check'], { stdio: 'pipe' })
    execFileSync(process.execPath, [script, '--root', root, '--brand', brand, '--write'], { stdio: 'pipe' })
    assert.equal(readFileSync(join(root, 'apps', 'desktop', 'cli', 'dsh'), 'utf8'), posix)
    assert.equal(readFileSync(join(root, 'apps', 'desktop', 'cli', 'dsh.cmd'), 'utf8'), windows)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('check rejects an unbranded launcher', () => {
  const root = fixture()
  try {
    assert.throws(() => execFileSync(process.execPath, [script, '--root', root, '--brand', brand, '--check'], { stdio: 'pipe' }))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
