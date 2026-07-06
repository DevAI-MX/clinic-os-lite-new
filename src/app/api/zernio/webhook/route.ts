import { NextResponse, after } from 'next/server'
import { getZernioConfig } from '@/lib/zernio/config'
import {
  verifyZernioSignature,
  zernioWebhookSecretPolicy,
} from '@/lib/zernio/signature'
import { processZernioEvent, type ZernioWebhookEvent } from '@/lib/zernio/inbound'

// Same rationale as the Meta webhook route: inbound processing runs
// inside after(), which is bounded by this route's maxDuration.
export const maxDuration = 60

/**
 * POST /api/zernio/webhook — Zernio event ingestion.
 *
 * Mirrors /api/whatsapp/webhook: read the raw body first (HMAC covers
 * the exact bytes; request.json() would re-encode and break it),
 * verify the X-Zernio-Signature header, ack 200 immediately, and do
 * the real work inside after() so Zernio's delivery timeout can't
 * trigger retries + duplicate inserts, while the runtime still keeps
 * the function alive until processing finishes (see issue #301 on the
 * Meta route for why a detached promise is NOT equivalent).
 */
export async function POST(request: Request) {
  const rawBody = await request.text()
  const signature = request.headers.get('x-zernio-signature')
  const { webhookSecret } = getZernioConfig()

  const policy = zernioWebhookSecretPolicy(webhookSecret)
  if (policy === 'reject') {
    // Fail closed in production — an unset secret would otherwise
    // leave a fully spoofable ingestion endpoint on the open internet.
    console.error(
      '[zernio-webhook] ZERNIO_WEBHOOK_SECRET is not set — rejecting request. ' +
        'Register the webhook with a secret (POST /v1/webhooks) and configure ' +
        'the same value here. See docs/ZERNIO.md.',
    )
    return NextResponse.json(
      { error: 'Webhook secret not configured' },
      { status: 503 },
    )
  }
  if (policy === 'allow-dev') {
    console.warn(
      '[zernio-webhook] ZERNIO_WEBHOOK_SECRET not set — accepting UNVERIFIED ' +
        'request (development only; production rejects these).',
    )
  } else if (!verifyZernioSignature(rawBody, signature, webhookSecret)) {
    // 401 (not 200) so Zernio's delivery log shows failures loudly if a
    // misconfiguration makes signatures stop matching — same stance as
    // the Meta webhook.
    console.warn('[zernio-webhook] rejected request with invalid signature')
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  let body: ZernioWebhookEvent
  try {
    body = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  if (!body || typeof body !== 'object' || typeof body.event !== 'string') {
    return NextResponse.json({ error: 'Missing event field' }, { status: 400 })
  }

  after(async () => {
    // processZernioEvent owns its try/catch and never throws, but keep
    // the belt-and-braces guard the Meta route uses.
    try {
      await processZernioEvent(body)
    } catch (error) {
      console.error('[zernio-webhook] error processing event:', error)
    }
  })

  return NextResponse.json({ status: 'received' }, { status: 200 })
}
