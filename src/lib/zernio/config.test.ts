import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getZernioConfig,
  isZernioDryRun,
  zernioEnabled,
  ZERNIO_DEFAULT_BASE_URL,
} from './config'

// config.ts reads process.env at CALL time (never at module load), so
// stubbing env per-test is enough — no module re-imports needed.

afterEach(() => {
  vi.unstubAllEnvs()
})

function clearZernioEnv() {
  for (const key of [
    'ZERNIO_API_KEY',
    'ZERNIO_ACCOUNT_ID',
    'ZERNIO_WEBHOOK_SECRET',
    'ZERNIO_BASE_URL',
    'ZERNIO_WACRM_ACCOUNT_ID',
    'ZERNIO_DRY_RUN',
  ]) {
    vi.stubEnv(key, '')
  }
}

describe('zernioEnabled', () => {
  it('is false with no configuration at all', () => {
    clearZernioEnv()
    expect(zernioEnabled()).toBe(false)
  })

  it('is false with only the API key (account id missing)', () => {
    clearZernioEnv()
    vi.stubEnv('ZERNIO_API_KEY', 'zk_test')
    expect(zernioEnabled()).toBe(false)
  })

  it('is false with only the account id (API key missing)', () => {
    clearZernioEnv()
    vi.stubEnv('ZERNIO_ACCOUNT_ID', 'acc_1')
    expect(zernioEnabled()).toBe(false)
  })

  it('is true when both API key and account id are present', () => {
    clearZernioEnv()
    vi.stubEnv('ZERNIO_API_KEY', 'zk_test')
    vi.stubEnv('ZERNIO_ACCOUNT_ID', 'acc_1')
    expect(zernioEnabled()).toBe(true)
  })

  it('is true under ZERNIO_DRY_RUN=true even without credentials', () => {
    clearZernioEnv()
    vi.stubEnv('ZERNIO_DRY_RUN', 'true')
    expect(zernioEnabled()).toBe(true)
    expect(isZernioDryRun()).toBe(true)
  })

  it('treats whitespace-only env values as absent', () => {
    clearZernioEnv()
    vi.stubEnv('ZERNIO_API_KEY', '   ')
    vi.stubEnv('ZERNIO_ACCOUNT_ID', 'acc_1')
    expect(zernioEnabled()).toBe(false)
  })
})

describe('getZernioConfig', () => {
  it('defaults the base URL and strips trailing slashes from overrides', () => {
    clearZernioEnv()
    expect(getZernioConfig().baseUrl).toBe(ZERNIO_DEFAULT_BASE_URL)

    vi.stubEnv('ZERNIO_BASE_URL', 'https://api.example.test/')
    expect(getZernioConfig().baseUrl).toBe('https://api.example.test')
  })

  it('only flags dry run on the exact string "true" (case-insensitive)', () => {
    clearZernioEnv()
    vi.stubEnv('ZERNIO_DRY_RUN', 'TRUE')
    expect(isZernioDryRun()).toBe(true)
    vi.stubEnv('ZERNIO_DRY_RUN', '1')
    expect(isZernioDryRun()).toBe(false)
  })
})
