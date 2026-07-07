import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { loadAiConfig } from '@/lib/ai/config'
import { AiError } from '@/lib/ai/types'
import {
  pickVoiceApiKey,
  prepareTtsText,
  synthesizeSpeech,
} from '@/lib/ai/concierge/voice'

export const maxDuration = 60

/**
 * POST /api/ai/concierge/tts  (agent+)
 *
 * TTS del Concierge: { text } → audio/mpeg streameado directo del
 * proveedor al <audio> del navegador (reproduce progresivamente).
 * Sin key OpenAI → 400 `voice_unavailable` (la UI cae a speechSynthesis).
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent')

    const limit = checkRateLimit(`concierge-voice:${userId}`, RATE_LIMITS.aiDraft)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    const text = prepareTtsText(typeof body?.text === 'string' ? body.text : '')
    if (!text) {
      return NextResponse.json({ error: 'text is required' }, { status: 400 })
    }

    const config = await loadAiConfig(supabase, accountId, {
      requireActive: false,
    }).catch(() => {
      throw new AiError('Stored API key could not be decrypted.', {
        code: 'key_decrypt_failed',
        status: 400,
      })
    })
    const voiceKey = config ? pickVoiceApiKey(config) : null
    if (!voiceKey) {
      return NextResponse.json(
        {
          error:
            'La voz necesita una key de OpenAI (la del agente, o la de embeddings si usas Anthropic).',
          code: 'voice_unavailable',
        },
        { status: 400 },
      )
    }

    const upstream = await synthesizeSpeech({ apiKey: voiceKey, text })
    return new Response(upstream.body, {
      headers: {
        'Content-Type': 'audio/mpeg',
        'Cache-Control': 'no-store',
      },
    })
  } catch (err) {
    if (err instanceof AiError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.status },
      )
    }
    return toErrorResponse(err)
  }
}
