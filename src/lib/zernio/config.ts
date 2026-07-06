// ============================================================
// Zernio adapter — configuration.
//
// Zernio (https://zernio.com) wraps Meta's official WhatsApp Cloud
// API. When the adapter is enabled, ALL outbound WhatsApp traffic
// (text / media / template) is routed through Zernio instead of
// hitting graph.facebook.com directly, and inbound traffic arrives
// on /api/zernio/webhook instead of /api/whatsapp/webhook.
//
// Everything is driven by environment variables (see docs/ZERNIO.md):
//
//   ZERNIO_API_KEY           API key from the Zernio dashboard.
//   ZERNIO_ACCOUNT_ID        The connected WhatsApp social-account id
//                            on Zernio (NOT a wacrm account id).
//   ZERNIO_WEBHOOK_SECRET    HMAC secret registered with the webhook.
//   ZERNIO_BASE_URL          API base. Defaults to the production
//                            server advertised in Zernio's OpenAPI
//                            spec (`https://zernio.com/api`); override
//                            if your tenant lives elsewhere.
//   ZERNIO_WACRM_ACCOUNT_ID  Optional. Pins Zernio traffic to a
//                            specific wacrm account (see below).
//   ZERNIO_DRY_RUN           "true" → no credentials needed; sends
//                            are logged and succeed synthetically.
//
// Every getter reads process.env at CALL time (no module-level
// snapshot) so tests can stub env vars and serverless platforms can
// rotate secrets without a rebuild.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

/** Default API base, from the `servers:` block of Zernio's OpenAPI spec. */
export const ZERNIO_DEFAULT_BASE_URL = 'https://zernio.com/api'

export interface ZernioConfig {
  apiKey: string | null
  /** Zernio's id for the connected WhatsApp account. */
  accountId: string | null
  webhookSecret: string | null
  /** Never has a trailing slash. */
  baseUrl: string
  /** Optional pin to a specific wacrm account (see resolveZernioWacrmAccount). */
  wacrmAccountId: string | null
  dryRun: boolean
}

function env(name: string): string | null {
  const v = process.env[name]
  return v && v.trim() !== '' ? v.trim() : null
}

export function getZernioConfig(): ZernioConfig {
  return {
    apiKey: env('ZERNIO_API_KEY'),
    accountId: env('ZERNIO_ACCOUNT_ID'),
    webhookSecret: env('ZERNIO_WEBHOOK_SECRET'),
    baseUrl: (env('ZERNIO_BASE_URL') ?? ZERNIO_DEFAULT_BASE_URL).replace(/\/+$/, ''),
    wacrmAccountId: env('ZERNIO_WACRM_ACCOUNT_ID'),
    dryRun: env('ZERNIO_DRY_RUN')?.toLowerCase() === 'true',
  }
}

/** True when ZERNIO_DRY_RUN=true — local development without credentials. */
export function isZernioDryRun(): boolean {
  return getZernioConfig().dryRun
}

/**
 * Should WhatsApp traffic route through Zernio?
 *
 * True when both ZERNIO_API_KEY and ZERNIO_ACCOUNT_ID are present —
 * OR when ZERNIO_DRY_RUN=true, so the dry-run path is actually
 * reachable through the outbound send branch during local development
 * (the client then logs the send and returns a synthetic id instead
 * of calling the network).
 */
export function zernioEnabled(): boolean {
  const cfg = getZernioConfig()
  return (Boolean(cfg.apiKey) && Boolean(cfg.accountId)) || cfg.dryRun
}

// ============================================================
// wacrm account resolution (V1: single clinic).
//
// The Meta webhook resolves the owning wacrm account per-event via
// whatsapp_config.phone_number_id — a natural key Meta puts on every
// payload. Zernio events carry Zernio's own account id instead, which
// wacrm has no column for, so V1 pins ALL Zernio traffic to a single
// wacrm account:
//
//   1. ZERNIO_WACRM_ACCOUNT_ID, when set — looked up in `accounts`
//      (fails loudly if the id doesn't exist, instead of silently
//      writing rows into the void).
//   2. Otherwise the account that owns the first whatsapp_config row
//      (oldest created_at). This matches the Meta webhook's anchor
//      table, and gives us the config owner's user_id for the NOT
//      NULL audit columns — the exact same value the Meta path uses.
//   3. Otherwise (no whatsapp_config at all — a Zernio-only install)
//      the oldest row in `accounts`, attributed to its owner.
//
// Multi-tenant Zernio routing (mapping Zernio account.id → wacrm
// account) is a schema change and out of scope for V1.
// ============================================================

export interface ZernioWacrmAccount {
  accountId: string
  /** Sender-of-record for NOT NULL user_id audit columns. */
  userId: string
}

export async function resolveZernioWacrmAccount(
  db: SupabaseClient,
): Promise<ZernioWacrmAccount | null> {
  const pinned = getZernioConfig().wacrmAccountId

  if (pinned) {
    const { data, error } = await db
      .from('accounts')
      .select('id, owner_user_id')
      .eq('id', pinned)
      .maybeSingle()
    if (error || !data) {
      console.error(
        `[zernio] ZERNIO_WACRM_ACCOUNT_ID="${pinned}" does not match any accounts row — dropping event.`,
        error ?? '',
      )
      return null
    }
    return { accountId: data.id, userId: data.owner_user_id }
  }

  // Anchor to the first WhatsApp config, mirroring the Meta webhook's
  // account resolution (and reusing its user_id attribution rule).
  const { data: config } = await db
    .from('whatsapp_config')
    .select('account_id, user_id')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (config?.account_id && config.user_id) {
    return { accountId: config.account_id, userId: config.user_id }
  }

  // Zernio-only install: no whatsapp_config row yet.
  const { data: account, error } = await db
    .from('accounts')
    .select('id, owner_user_id')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (error || !account) {
    console.error(
      '[zernio] no accounts row found — cannot attribute Zernio traffic. Create an account first.',
      error ?? '',
    )
    return null
  }
  return { accountId: account.id, userId: account.owner_user_id }
}
