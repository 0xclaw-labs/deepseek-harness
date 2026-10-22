import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const script = join(here, 'apply-brand.mjs')
const brand = join(here, 'brand.json')

/** Brand manifest without assets: these tests cover the copy transform, not icon copying. */
const FIXTURE_BRAND = { schema: 'sdz-fork-brand/v1', productName: '随身搭子' }

/** Source copy the transform must brand, plus the expected-output fixture shape it must also follow. */
const SOURCE_TS = [
  "export const en = {",
  "  aboutMenu: 'About DeepSeek Harness',",
  "  welcomeKeyDescription: 'Configure official DeepSeek models to start using Harness',",
  '}',
  '',
].join('\n')
const EXPECTED_JSON = `${JSON.stringify({ menu: [{ label: 'About DeepSeek Harness' }], welcomeKeyDescription: 'Configure official DeepSeek models to start using Harness' }, null, 2)}\n`
const SKIPPED_SPEC = "assert.equal(t('aboutMenu'), 'About DeepSeek Harness')\n"

/**
 * Build one throwaway checkout with an included source tree, an excluded
 * `tests/` segment, and a replacement spec that names one file inside it.
 * @returns root plus the paths the assertions read.
 */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-apply-brand-'))
  const write = (rel, text) => {
    const path = join(root, rel)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, text)
  }
  write('apps/desktop/src/locale.ts', SOURCE_TS)
  write('apps/desktop/tests/expected/about-panel.json', EXPECTED_JSON)
  write('apps/desktop/tests/main-startup.spec.ts', SKIPPED_SPEC)
  write('apps/desktop/tests/ignored.txt', 'About DeepSeek Harness\n')
  const spec = join(root, 'replacements.json')
  writeFileSync(spec, `${JSON.stringify({
    schema: 'sdz-fork-brand-replacements/v1',
    includeDirs: ['apps/desktop/src'],
    extensions: ['.ts', '.json'],
    excludeSegments: ['node_modules', 'tests'],
    includeFiles: ['apps/desktop/tests/expected/about-panel.json'],
    replacements: [
      { from: 'DeepSeek Harness', to: '随身搭子' },
      { from: 'official DeepSeek models', to: 'your PaiNuo models' },
      { from: 'start using Harness', to: 'start using 随身搭子' },
    ],
  }, null, 2)}\n`)
  writeFileSync(join(root, 'fixture-brand.json'), `${JSON.stringify(FIXTURE_BRAND, null, 2)}\n`)
  return { root, spec, read: (rel) => readFileSync(join(root, rel), 'utf8') }
}

/**
 * Run the transform in one mode against a fixture.
 * @returns combined stdout and stderr: the skip notes this suite asserts on are warnings.
 */
function run(root, spec, mode) {
  const result = spawnSync(process.execPath, [
    script, '--root', root, '--brand', join(root, 'fixture-brand.json'), '--replacements', spec, mode,
  ], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return `${result.stdout}${result.stderr}`
}

test('check mode reports the branded copy without writing', () => {
  const { root, spec, read } = fixture()
  try {
    const output = run(root, spec, '--check')
    assert.match(output, /mode=check|apply-brand\[check\]/)
    assert.equal(read('apps/desktop/src/locale.ts'), SOURCE_TS)
    // The report names each rule's own target, not the product name for all of them.
    assert.match(output, /"DeepSeek Harness" -> "随身搭子"/)
    assert.match(output, /"official DeepSeek models" -> "your PaiNuo models"/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('write mode brands included sources and each rule keeps its own target', () => {
  const { root, spec, read } = fixture()
  try {
    run(root, spec, '--write')
    const source = read('apps/desktop/src/locale.ts')
    assert.doesNotMatch(source, /DeepSeek/)
    assert.match(source, /aboutMenu: 'About 随身搭子'/)
    assert.match(source, /'Configure your PaiNuo models to start using 随身搭子'/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('an excluded tests segment is untouched unless a file is named explicitly', () => {
  const { root, spec, read } = fixture()
  try {
    run(root, spec, '--write')
    // Named by includeFiles: follows the branded sources so the branded build's own
    // test expectation does not pin upstream copy.
    const expected = read('apps/desktop/tests/expected/about-panel.json')
    assert.doesNotMatch(expected, /DeepSeek/)
    assert.match(expected, /About 随身搭子/)
    // Every other file under the excluded segment keeps upstream copy.
    assert.equal(read('apps/desktop/tests/main-startup.spec.ts'), SKIPPED_SPEC)
    assert.equal(read('apps/desktop/tests/ignored.txt'), 'About DeepSeek Harness\n')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a missing includeFiles entry is skipped instead of failing the build', () => {
  const { root, spec, read } = fixture()
  try {
    rmSync(join(root, 'apps/desktop/tests/expected/about-panel.json'))
    const output = run(root, spec, '--write')
    assert.match(output, /includeFiles entry is missing/)
    assert.match(read('apps/desktop/src/locale.ts'), /随身搭子/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the shipped spec brands the desktop welcome copy and the about expectation', () => {
  assert.equal(JSON.parse(readFileSync(brand, 'utf8')).productName, '随身搭子')
  const spec = JSON.parse(readFileSync(join(here, 'replacements.json'), 'utf8'))
  const rules = new Map(spec.replacements.map((r) => [r.from, r.to]))
  assert.equal(rules.get('DeepSeek Harness'), '随身搭子')
  assert.equal(rules.get('official DeepSeek models'), 'your PaiNuo models')
  assert.equal(rules.get('DeepSeek 官方模型'), '派诺模型')
  assert.equal(rules.get('start using Harness'), 'start using 随身搭子')
  assert.ok(spec.includeFiles.includes('apps/desktop/tests/expected/about-panel.json'))
})