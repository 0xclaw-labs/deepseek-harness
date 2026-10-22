import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'

it('keeps desktop product analytics disabled in the brand composition', () => {
  const parsed = yaml.load(
    readFileSync(fileURLToPath(new URL('../cordis.patch.yml', import.meta.url)), 'utf8'),
    { schema: entryListSchema },
  )
  if (!Array.isArray(parsed)) throw new TypeError('web-app patch must parse to a patch list')
  const rows = parsed.flatMap((patch): Record<string, unknown>[] =>
    typeof patch === 'object' && patch !== null
      ? (patch as { insert?: Record<string, unknown>[] }).insert ?? []
      : [],
  )
  for (const id of ['desktop-product-telemetry', 'product-analytics']) {
    const row = rows.find(candidate => candidate.id === id)
    expect(row?.disabled, `${id} must not send to an upstream collector`).toBe(true)
  }
  expect(JSON.stringify(rows)).not.toMatch(/deepseek\.com|deepseeksvc\.com/u)
})
