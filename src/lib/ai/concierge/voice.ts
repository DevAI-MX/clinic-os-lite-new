// ============================================================
// clinicOS — voz del Concierge (STT + TTS), siempre sobre OpenAI.
//
// Anthropic no ofrece speech; la voz es ortogonal al "cerebro" del
// agente. La key se resuelve del BYO de la cuenta: si el proveedor del
// chat es OpenAI se usa esa misma key; si es Anthropic se recurre a la
// key de embeddings (que por contrato ya es siempre OpenAI). Sin key
// OpenAI → las rutas responden `voice_unavailable` y la UI degrada
// (dictado deshabilitado, TTS cae a speechSynthesis del navegador).
// ============================================================

import { AiError } from '../types'
import { aiRequestTimeoutMs } from '../defaults'

/** STT — dictados cortos del equipo; suficiente y barato. */
export const STT_MODEL = 'gpt-4o-mini-transcribe'
/** TTS — voz natural con instrucciones de tono. */
export const TTS_MODEL = 'gpt-4o-mini-tts'
export const TTS_VOICE = 'coral'
export const TTS_INSTRUCTIONS =
  'Habla en español mexicano, con tono cálido y profesional, ritmo natural y ágil. Eres la voz del asistente interno de una clínica.'

/** Tope del blob de audio a transcribir (un dictado de 2 min en Opus
 *  pesa ~1–2 MB; esto es holgura, no meta). */
export const STT_MAX_BYTES = 8 * 1024 * 1024

/** Tope de texto por síntesis (el límite duro de OpenAI es 4096). */
export const TTS_MAX_CHARS = 3000

export interface VoiceKeySource {
  provider: 'openai' | 'anthropic'
  apiKey: string
  embeddingsApiKey: string | null
}

/** Key OpenAI utilizable para voz, o null si la cuenta no tiene. */
export function pickVoiceApiKey(config: VoiceKeySource): string | null {
  if (config.provider === 'openai') return config.apiKey
  return config.embeddingsApiKey
}

/**
 * Limpia el texto del asistente para leerse en voz alta: fuera markdown
 * (negritas, encabezados, bullets, código, links) y con tope de largo
 * cortado en frontera de oración.
 */
export function prepareTtsText(raw: string): string {
  let text = raw
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_#>]+/g, ' ')
    .replace(/^\s*[-•]\s+/gm, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim()

  if (text.length > TTS_MAX_CHARS) {
    const slice = text.slice(0, TTS_MAX_CHARS)
    const lastStop = Math.max(
      slice.lastIndexOf('. '),
      slice.lastIndexOf('.\n'),
      slice.lastIndexOf('? '),
      slice.lastIndexOf('! '),
    )
    text = lastStop > TTS_MAX_CHARS / 2 ? slice.slice(0, lastStop + 1) : slice
  }
  return text
}

/** Transcribe un blob de audio del navegador. Lanza AiError legible. */
export async function transcribeAudio(args: {
  apiKey: string
  file: File
}): Promise<string> {
  const form = new FormData()
  form.append('file', args.file, args.file.name || 'dictado.webm')
  form.append('model', STT_MODEL)
  form.append('language', 'es')

  let res: Response
  try {
    res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${args.apiKey}` },
      body: form,
      signal: AbortSignal.timeout(aiRequestTimeoutMs()),
    })
  } catch {
    throw new AiError('No pude contactar el servicio de voz.', {
      code: 'voice_network',
      status: 502,
    })
  }
  if (!res.ok) {
    if (res.status === 401) {
      throw new AiError('La key de OpenAI para voz no es válida.', {
        code: 'invalid_key',
        status: 400,
      })
    }
    throw new AiError('La transcripción falló. Intenta de nuevo.', {
      code: 'voice_stt_failed',
      status: 502,
    })
  }
  const data = (await res.json().catch(() => ({}))) as { text?: string }
  const text = typeof data.text === 'string' ? data.text.trim() : ''
  if (!text) {
    throw new AiError('No se escuchó nada en el audio.', {
      code: 'voice_empty',
      status: 400,
    })
  }
  return text
}

/**
 * Sintetiza voz para un texto ya preparado. Devuelve el Response de
 * OpenAI verificado (ok) para que el route streamee `res.body` tal cual.
 */
export async function synthesizeSpeech(args: {
  apiKey: string
  text: string
}): Promise<Response> {
  let res: Response
  try {
    res = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${args.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: TTS_MODEL,
        voice: TTS_VOICE,
        input: args.text,
        instructions: TTS_INSTRUCTIONS,
        response_format: 'mp3',
      }),
      signal: AbortSignal.timeout(aiRequestTimeoutMs()),
    })
  } catch {
    throw new AiError('No pude contactar el servicio de voz.', {
      code: 'voice_network',
      status: 502,
    })
  }
  if (!res.ok || !res.body) {
    if (res.status === 401) {
      throw new AiError('La key de OpenAI para voz no es válida.', {
        code: 'invalid_key',
        status: 400,
      })
    }
    throw new AiError('La síntesis de voz falló.', {
      code: 'voice_tts_failed',
      status: 502,
    })
  }
  return res
}
