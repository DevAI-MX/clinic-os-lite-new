import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { verifyZernioSignature, zernioWebhookSecretPolicy } from './signature'

const SECRET = 'zernio-test-secret'
const BODY = JSON.stringify({ event: 'message.received', message: { id: 'm1' } })

function hex(secret: string, message: string): string {
  return createHmac('sha256', secret).update(message).digest('hex')
}

function b64(secret: string, message: string): string {
  return createHmac('sha256', secret).update(message).digest('base64')
}

describe('verifyZernioSignature — raw hex format', () => {
  it('accepts a raw hex HMAC of the body', () => {
    expect(verifyZernioSignature(BODY, hex(SECRET, BODY), SECRET)).toBe(true)
  })

  it('accepts uppercase hex (hex is case-insensitive)', () => {
    expect(
      verifyZernioSignature(BODY, hex(SECRET, BODY).toUpperCase(), SECRET),
    ).toBe(true)
  })

  it('accepts a "sha256=" prefixed hex digest (Meta-style)', () => {
    expect(
      verifyZernioSignature(BODY, `sha256=${hex(SECRET, BODY)}`, SECRET),
    ).toBe(true)
  })

  it('rejects a signature computed with the wrong secret', () => {
    expect(verifyZernioSignature(BODY, hex('wrong', BODY), SECRET)).toBe(false)
  })

  it('rejects a signature over a different body (tampering)', () => {
    expect(
      verifyZernioSignature(BODY, hex(SECRET, BODY + 'x'), SECRET),
    ).toBe(false)
  })
})

describe('verifyZernioSignature — base64 format', () => {
  it('accepts a base64 HMAC of the body', () => {
    expect(verifyZernioSignature(BODY, b64(SECRET, BODY), SECRET)).toBe(true)
  })

  it('rejects a wrong base64 digest', () => {
    expect(verifyZernioSignature(BODY, b64('wrong', BODY), SECRET)).toBe(false)
  })
})

describe('verifyZernioSignature — Stripe-style t=…,v1=…', () => {
  it('accepts v1 signed over "${t}.${body}" (Stripe semantics)', () => {
    const t = '1751800000'
    const header = `t=${t},v1=${hex(SECRET, `${t}.${BODY}`)}`
    expect(verifyZernioSignature(BODY, header, SECRET)).toBe(true)
  })

  it('accepts v1 signed over the raw body alone (timestamp not covered)', () => {
    const header = `t=1751800000,v1=${hex(SECRET, BODY)}`
    expect(verifyZernioSignature(BODY, header, SECRET)).toBe(true)
  })

  it('tolerates whitespace after commas and uppercase v1 hex', () => {
    const t = '1751800000'
    const sig = hex(SECRET, `${t}.${BODY}`).toUpperCase()
    expect(verifyZernioSignature(BODY, `t=${t}, v1=${sig}`, SECRET)).toBe(true)
  })

  it('rejects when the timestamp is altered (breaks the covered HMAC)', () => {
    const header = `t=999,v1=${hex(SECRET, `1751800000.${BODY}`)}`
    expect(verifyZernioSignature(BODY, header, SECRET)).toBe(false)
  })

  it('rejects a wrong v1', () => {
    const header = `t=1751800000,v1=${hex('wrong', `1751800000.${BODY}`)}`
    expect(verifyZernioSignature(BODY, header, SECRET)).toBe(false)
  })
})

describe('verifyZernioSignature — fail-closed edges', () => {
  it('rejects a missing header', () => {
    expect(verifyZernioSignature(BODY, null, SECRET)).toBe(false)
  })

  it('rejects an empty header', () => {
    expect(verifyZernioSignature(BODY, '   ', SECRET)).toBe(false)
  })

  it('rejects when the secret is missing', () => {
    expect(verifyZernioSignature(BODY, hex(SECRET, BODY), null)).toBe(false)
    expect(verifyZernioSignature(BODY, hex(SECRET, BODY), '')).toBe(false)
  })

  it('rejects garbage that matches no known format', () => {
    expect(verifyZernioSignature(BODY, 'not-a-signature', SECRET)).toBe(false)
    expect(verifyZernioSignature(BODY, 'sha256=zzzz', SECRET)).toBe(false)
  })
})

describe('zernioWebhookSecretPolicy', () => {
  it('verifies when a secret is configured, regardless of env', () => {
    expect(zernioWebhookSecretPolicy('s', 'production')).toBe('verify')
    expect(zernioWebhookSecretPolicy('s', 'development')).toBe('verify')
  })

  it('rejects in production when the secret is missing (fail closed)', () => {
    expect(zernioWebhookSecretPolicy(null, 'production')).toBe('reject')
  })

  it('allows with warning outside production when the secret is missing', () => {
    expect(zernioWebhookSecretPolicy(null, 'development')).toBe('allow-dev')
    expect(zernioWebhookSecretPolicy(null, 'test')).toBe('allow-dev')
    expect(zernioWebhookSecretPolicy(null, undefined)).toBe('allow-dev')
  })
})
