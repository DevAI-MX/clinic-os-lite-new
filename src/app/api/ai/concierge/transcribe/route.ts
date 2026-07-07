import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { loadAiConfig } from '@/lib/ai/config'
import { AiError } from '@/lib/ai/types'
import {
  pickVoiceApiKey,
  transcribeAudio,
  STT_MAX_BYTES,
} from '@/lib/ai/concierge/voice'

export const maxDuration = 60

/**
 * POST /api/ai/concierge/transcribe  (agent+)
 *
 * STT del Concierge: recibe multipart { audio: File } (el blob del
 * MediaRecorder del navegador — webm/opus en Chrome, mp4 en Safari) y
 * devuelve { text } transcrito con la key OpenAI de la cuenta.
 * Sin key OpenAI → 400 `voice_unavailable` (la UI degrada el dictado).
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent')

    const limit = checkRateLimit(`concierge-voice:${userId}`, RATE_LIMITS.aiDraft)
    if (!limit.success) return rateLimitResponse(limit)

    const form = await request.formData().catch(() => null)
    const file = form?.get('audio')
    if (!(file instanceof File) || file.size === 0) {
      return NextResponse.json({ error: 'audio file is required' }, { status: 400 })
    }
    if (file.size > STT_MAX_BYTES) {
      return NextResponse.json(
        { error: 'El audio es demasiado grande.' },
        { status: 400 },
      )
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

    const text = await transcribeAudio({ apiKey: voiceKey, file })
    return NextResponse.json({ text })
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
