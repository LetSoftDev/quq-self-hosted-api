import { describe, it, expect, afterEach } from 'vitest'
import { envNumber } from './env'

describe('envNumber', () => {
  afterEach(() => {
    delete process.env.TEST_ENV_NUMBER
  })

  it('reads a positive integer from the environment', () => {
    process.env.TEST_ENV_NUMBER = '42'
    expect(envNumber('TEST_ENV_NUMBER', 7)).toBe(42)
  })

  it('falls back when the variable is unset, not a number, zero or negative', () => {
    expect(envNumber('TEST_ENV_NUMBER', 7)).toBe(7)
    for (const value of ['', 'abc', '0', '-5']) {
      process.env.TEST_ENV_NUMBER = value
      expect(envNumber('TEST_ENV_NUMBER', 7)).toBe(7)
    }
  })
})
