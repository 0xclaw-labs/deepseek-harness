import { expect, it } from 'vitest'
import { Config } from '../src/index.ts'

it('defaults both account origins to the PaiNuo ecosystem shim', () => {
  const config = Config({})
  expect(config.platformOrigin).toBe('https://auth.modelxing.com')
  expect(config.inferenceOrigin).toBe('https://auth.modelxing.com')
})
