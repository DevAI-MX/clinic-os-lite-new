// ============================================================
// Zernio outbound client.
//
// Thin wrapper over Zernio's WhatsApp send endpoint:
//
//   POST {ZERNIO_BASE_URL}/v1/accounts/{accountId}/whatsapp/messages
//   Authorization: Bearer <ZERNIO_API_KEY>
//   { to: "+52…", messageType: "text"|"media"|"template",
//     text, media: { mediaType, url, caption },
//     template: { name, language, variableMapping } }
//
// Mirrors src/lib/whatsapp/meta-api.ts conventions:
//   * every function takes a single named-params object,
//   * non-2xx responses throw an Error carrying the API's message,
//   * the resolved message id is returned as `{ messageId }`.
//
// Dry-run: with ZERNIO_DRY_RUN=true and no API key, sends are logged
// and succeed synthetically so the full pipeline can be exercised
// locally without credentials (and without a network).
// ============================================================

import { getZernioConfig } from './config'

export interface ZernioSendResult {
  /**
   * The id persisted to messages.message_id. We prefer WhatsApp's own
   * platformMessageId (wamid) when Zernio returns it — that keeps ids
   * comparable with the Meta-direct path — and fall back to Zernio's
   * internal message id. Delivery-status matching checks both (see
   * inbound.ts).
   */
  messageId: string
}

interface ZernioErrorShape {
  error?: { message?: string; code?: string } | string
  message?: string
}

async function throwZernioError(response: Response, fallback: string): Promise<never> {
  let message = fallback
  try {
    const data = (await response.json()) as ZernioErrorShape
    if (typeof data.error === 'string') message = data.error
    else if (data.error?.message) message = data.error.message
    else if (data.message) message = data.message
  } catch {
    // body wasn't JSON — keep the fallback
  }
  throw new Error(message)
}

/**
 * Zernio expects E.164 with a leading `+`; the rest of wacrm passes
 * Meta-style digits-only numbers around. Accept either.
 */
export function toZernioPhone(to: string): string {
  const digits = to.replace(/\D/g, '')
  return `+${digits}`
}

/**
 * Pull a message id out of Zernio's send response. The response
 * envelope isn't pinned down in their spec, so accept the common
 * shapes: `{ message: {...} }`, a bare message object, or flat ids.
 */
export function extractZernioMessageId(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null
  const d = data as Record<string, unknown>
  const msg = (d.message && typeof d.message === 'object' ? d.message : d) as Record<string, unknown>
  for (const key of ['platformMessageId', 'messageId', 'id'] as const) {
    const v = msg[key]
    if (typeof v === 'string' && v) return v
  }
  return null
}

async function zernioPost(body: Record<string, unknown>): Promise<ZernioSendResult> {
  const cfg = getZernioConfig()

  if (!cfg.apiKey && cfg.dryRun) {
    const messageId = `zernio-dry-run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    console.log('[zernio] DRY RUN — send skipped:', JSON.stringify(body), '→', messageId)
    return { messageId }
  }

  if (!cfg.apiKey || !cfg.accountId) {
    throw new Error(
      'Zernio is not configured: set ZERNIO_API_KEY and ZERNIO_ACCOUNT_ID (or ZERNIO_DRY_RUN=true for local development).',
    )
  }

  const url = `${cfg.baseUrl}/v1/accounts/${encodeURIComponent(cfg.accountId)}/whatsapp/messages`
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    await throwZernioError(response, `Zernio API error: ${response.status}`)
  }
  const data = await response.json().catch(() => null)
  const messageId = extractZernioMessageId(data)
  if (!messageId) {
    throw new Error('Zernio accepted the message but returned no message id.')
  }
  return { messageId }
}

// ============================================================
// Send helpers
// ============================================================

export interface ZernioSendTextArgs {
  /** Recipient phone — digits-only or +E.164, either works. */
  to: string
  text: string
}

export async function zernioSendText(args: ZernioSendTextArgs): Promise<ZernioSendResult> {
  if (!args.text) throw new Error('zernioSendText requires text.')
  return zernioPost({
    to: toZernioPhone(args.to),
    messageType: 'text',
    text: args.text,
  })
}

export type ZernioMediaType = 'image' | 'video' | 'document' | 'audio'

export interface ZernioSendMediaArgs {
  to: string
  mediaType: ZernioMediaType
  /** Public URL Zernio (→ Meta) fetches at send time. */
  url: string
  caption?: string
}

export async function zernioSendMedia(args: ZernioSendMediaArgs): Promise<ZernioSendResult> {
  if (!args.url) throw new Error('zernioSendMedia requires a url.')
  const media: Record<string, unknown> = {
    mediaType: args.mediaType,
    url: args.url,
  }
  // Meta rejects captions on audio; keep the same guard here.
  if (args.caption && args.mediaType !== 'audio') media.caption = args.caption
  return zernioPost({
    to: toZernioPhone(args.to),
    messageType: 'media',
    media,
  })
}

export interface ZernioSendTemplateArgs {
  to: string
  /** Template name as approved on the WABA (managed in Zernio). */
  name: string
  /** e.g. "es_MX", "en_US". */
  language: string
  /**
   * Body variable values keyed by position ("1", "2", …) — WhatsApp
   * numbers its body variables {{1}}, {{2}}, …
   */
  variableMapping?: Record<string, string>
}

export async function zernioSendTemplate(args: ZernioSendTemplateArgs): Promise<ZernioSendResult> {
  if (!args.name) throw new Error('zernioSendTemplate requires a template name.')
  const template: Record<string, unknown> = {
    name: args.name,
    language: args.language,
  }
  if (args.variableMapping && Object.keys(args.variableMapping).length > 0) {
    template.variableMapping = args.variableMapping
  }
  return zernioPost({
    to: toZernioPhone(args.to),
    messageType: 'template',
    template,
  })
}
