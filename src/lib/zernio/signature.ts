// ============================================================
// Zernio webhook signature verification.
//
// Zernio signs webhook POSTs with HMAC-SHA256 over the raw request
// body, delivered in the `X-Zernio-Signature` header. Their OpenAPI
// spec confirms the algorithm and header name but NOT the header's
// encoding, so this verifier is deliberately tolerant and accepts
// the common formats:
//
//   1. Raw hex digest:            "a1b2c3…" (64 hex chars)
//   2. Prefixed hex digest:       "sha256=a1b2c3…"
//   3. Base64 digest:             "obLD…=" (44 chars)
//   4. Stripe-style:              "t=<unix>,v1=<hex>"
//      where v1 is HMAC over `${t}.${rawBody}` (Stripe semantics) or,
//      as a fallback, over the raw body alone.
//
// Every candidate is recomputed from the ORIGINAL raw bytes and
// compared in constant time (crypto.timingSafeEqual with a length
// guard) — mirroring src/lib/whatsapp/webhook-signature.ts and
// src/lib/webhooks/sign.ts.
//
// No timestamp-freshness check is enforced on format 4: the exact
// unit (s vs ms) is undocumented, and a wrong guess would silently
// drop every legitimate event. The timestamp is still covered by the
// HMAC in the Stripe scheme, so it can't be forged.
// ============================================================

import crypto from 'node:crypto'

/** Constant-time equality with the mandatory length guard. */
function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ba.length !== bb.length) return false
  return crypto.timingSafeEqual(ba, bb)
}

function hmacHex(secret: string, message: string): string {
  return crypto.createHmac('sha256', secret).update(message).digest('hex')
}

function hmacBase64(secret: string, message: string): string {
  return crypto.createHmac('sha256', secret).update(message).digest('base64')
}

/**
 * Verify the `X-Zernio-Signature` header against the raw body.
 *
 * Fails closed: missing/empty secret or header → false. The route
 * decides separately what to do when NO secret is configured at all
 * (reject in prod, warn-and-accept in dev) — see zernioWebhookSecretPolicy.
 */
export function verifyZernioSignature(
  rawBody: string,
  signatureHeader: string | null,
  secret: string | null,
): boolean {
  if (!secret) return false
  if (!signatureHeader) return false
  const header = signatureHeader.trim()
  if (!header) return false

  // Stripe-style "t=…,v1=…"
  if (/(^|,)\s*v1=/.test(header) && /(^|,)\s*t=/.test(header)) {
    const parts = Object.fromEntries(
      header.split(',').map((kv) => {
        const i = kv.indexOf('=')
        return [kv.slice(0, i).trim(), kv.slice(i + 1).trim()]
      }),
    )
    const t = parts.t
    const v1 = (parts.v1 ?? '').toLowerCase()
    if (!t || !v1) return false
    // Primary: Stripe semantics — HMAC over `${t}.${rawBody}`.
    if (safeEqual(hmacHex(secret, `${t}.${rawBody}`), v1)) return true
    // Fallback: some providers put a timestamp in the header but still
    // sign only the raw body.
    return safeEqual(hmacHex(secret, rawBody), v1)
  }

  // "sha256=<hex>" (Meta-style prefix)
  const hex = header.startsWith('sha256=') ? header.slice('sha256='.length) : header

  // Raw hex digest (case-insensitive).
  if (/^[0-9a-fA-F]{64}$/.test(hex)) {
    return safeEqual(hmacHex(secret, rawBody), hex.toLowerCase())
  }

  // Base64 digest (a SHA-256 HMAC is always 44 base64 chars, "=" padded).
  if (/^[A-Za-z0-9+/]{43}=$/.test(header)) {
    return safeEqual(hmacBase64(secret, rawBody), header)
  }

  return false
}

// ============================================================
// Secret policy — what to do when ZERNIO_WEBHOOK_SECRET is absent.
// ============================================================

export type ZernioSecretPolicy =
  /** Secret configured — verify every request. */
  | 'verify'
  /** No secret + production → reject everything (fail closed). */
  | 'reject'
  /** No secret + development → accept with a loud warning. */
  | 'allow-dev'

/**
 * The Meta webhook fails closed when its secret is missing. For
 * Zernio we keep that stance in production, but allow local
 * development against a tunnel without a secret (with a warning) —
 * Zernio marks the signature as optional on their side, so a fresh
 * dev setup would otherwise be un-testable end to end.
 */
export function zernioWebhookSecretPolicy(
  secret: string | null,
  nodeEnv: string | undefined = process.env.NODE_ENV,
): ZernioSecretPolicy {
  if (secret) return 'verify'
  return nodeEnv === 'production' ? 'reject' : 'allow-dev'
}
