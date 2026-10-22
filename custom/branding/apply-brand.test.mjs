// Guards the shipped replacement data: the branded model display names reach the
// catalog-name sites, wire ids and request vocabulary stay the provider's own,
// a second --write is a no-op, and --check fails loud when upstream copy moves.
//
//   node --test custom/branding/apply-brand.test.mjs
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const repo = fileURLToPath(new URL('../..', import.meta.url))
const script = join(here, 'apply-brand.mjs')
const brand = join(here, 'brand.json')
const replacements = join(here, 'replacements.json')

/** Repo paths the shipped rules match, copied into a throwaway root. */
const FIXTURE_PATHS = [
  'apps/desktop/src',
  'packages/llm/llm-deepseek/src',
  'packages/client/ui-deepseek-model-label-1017/src',
  'packages/client/ui-model-selection/src',
  'packages/client/ui-settings-models/src',
]

const MODELS = 'packages/llm/llm-deepseek/src/models.ts'
const LABEL = 'packages/client/ui-deepseek-model-label-1017/src/client/DeepSeekModelLabel.tsx'
const SELECTION_LOCALES = 'packages/client/ui-model-selection/src/client/locales.ts'
const SETTINGS_LOCALES = 'packages/client/ui-settings-models/src/client/locales.ts'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-apply-brand-'))
  for (const path of FIXTURE_PATHS) cpSync(join(repo, path), join(root, path), { recursive: true })
  mkdirSync(join(root, 'apps', 'desktop', 'resources'), { recursive: true })
  return root
}

function run(root, mode) {
  return execFileSync(
    process.execPath,
    [script, '--root', root, '--brand', brand, '--replacements', replacements, mode],
    { encoding: 'utf8' },
  )
}

const read = (root, path) => readFileSync(join(root, path), 'utf8')

/** Every file below the fixture roots, keyed by its path relative to the root. */
function snapshot(root) {
  const files = new Map()
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) files.set(relative(root, full), readFileSync(full, 'utf8'))
    }
  }
  for (const path of FIXTURE_PATHS) walk(join(root, path))
  return files
}

/** Wire model ids declared in a catalog file; no rule may rewrite these. */
function wireIds(text) {
  return [...text.matchAll(/id: '([^']+)'/gu)].map((match) => match[1])
}

test('brands catalog display names and leaves every wire id alone', () => {
  const root = fixture()
  try {
    const idsBefore = wireIds(read(root, MODELS))
    assert.deepEqual(idsBefore, ['deepseek-flash', 'deepseek-v4-pro'])
    run(root, '--write')

    const models = read(root, MODELS)
    assert.match(models, /id: 'deepseek-flash'/)
    assert.match(models, /id: 'deepseek-v4-pro'/)
    assert.deepEqual(wireIds(models), idsBefore)
    assert.match(models, /name: '派诺·DeepSeek-V4\.1-Flash'/)
    assert.match(models, /name: '派诺·DeepSeek-V4-Pro'/)

    // The release badge compares the catalog name it pins, so both sites must
    // carry the same branded name or the badge silently stops rendering.
    assert.match(read(root, LABEL), /const MODEL_NAME = '派诺·DeepSeek-V4\.1-Flash'/)

    // The model selector names the account provider group, and the Models page
    // names its row, from these two dictionaries.
    const selection = read(root, SELECTION_LOCALES)
    assert.match(selection, /'provider\.account': '派诺生态账号'/)
    assert.doesNotMatch(selection, /'provider\.account': 'DeepSeek/u)

    const settings = read(root, SETTINGS_LOCALES)
    assert.match(settings, /deepSeekAccount: '派诺生态账号'/)
    assert.doesNotMatch(settings, /deepSeekAccount: 'DeepSeek/u)
    assert.match(settings, /Configure the PaiNuo ecosystem models to start building\./)
    // The Chinese sentence of that same onboarding step belongs to the general
    // copy pass (`DeepSeek 官方模型`), not to a second rule over the sentence.
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a second --write leaves an already-branded worktree byte-identical', () => {
  const root = fixture()
  try {
    run(root, '--write')
    const branded = snapshot(root)
    const output = run(root, '--write')
    assert.match(output, /already branded/)
    assert.deepEqual([...snapshot(root)], [...branded])
    assert.doesNotMatch(read(root, MODELS), /派诺·派诺·/u)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('--check passes on the pristine tree and names a rule whose copy moved', () => {
  const root = fixture()
  try {
    assert.match(run(root, '--check'), /派诺·DeepSeek-V4\.1-Flash/)
    // Upstream renames the locale key: the rule matches nothing, and the check
    // must say which string is stale instead of shipping an unbranded label.
    writeFileSync(
      join(root, SETTINGS_LOCALES),
      read(root, SETTINGS_LOCALES).replace(/deepSeekAccount: 'DeepSeek 账号'/u, "accountLabel: 'DeepSeek 账号'"),
    )
    assert.throws(
      () => run(root, '--check'),
      (error) => {
        assert.equal(error.status, 1)
        assert.match(error.stderr, /deepSeekAccount: 'DeepSeek 账号'/u)
        assert.match(error.stderr, /update replacements\.json/u)
        return true
      },
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})