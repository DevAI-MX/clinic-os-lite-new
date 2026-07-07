// ============================================================
// clinicOS — análisis de visión para imágenes del paciente.
//
// El transcript que lee el agente es solo texto (ChatMessage), así que
// una imagen entrante (típicamente el comprobante del anticipo) se
// analiza aquí en un paso previo: se descarga del URL que guardó el
// webhook, se manda al proveedor configurado (OpenAI o Anthropic, ambos
// con visión) con un prompt de extracción, y el resultado se inyecta a
// la corrida como "nota automática del sistema". El agente decide con
// esos datos (prevalidar_anticipo, escalar, etc.); la validación final
// del pago SIEMPRE es humana en el panel.
//
// Todo es best-effort: cualquier fallo (URL caído, modelo sin visión,
// JSON malformado) devuelve null y el agente corre igual — con la nota
// de "imagen sin analizar" para que aun así atienda el comprobante.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import type { AiProvider } from '../types'
import { aiRequestTimeoutMs } from '../defaults'

/** Datos extraídos de la imagen. Campos null = no visibles/no aplica. */
export interface ReceiptAnalysis {
  esComprobante: boolean
  monto: number | null
  moneda: string | null
  fecha: string | null
  banco: string | null
  referencia: string | null
  titular: string | null
  /** Qué se ve en la imagen (una frase), sea o no un comprobante. */
  descripcion: string | null
}

/** Tope de descarga: un comprobante real pesa cientos de KB. */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024

/** Tipos que aceptan ambos proveedores en bloques de imagen. */
const SUPPORTED_MEDIA_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
])

const EXTRACTION_PROMPT = `Analiza la imagen que un paciente envió por WhatsApp a la recepción de una clínica. Lo más probable es que sea un comprobante de pago (captura de transferencia SPEI, depósito o recibo), pero puede ser cualquier otra cosa.

Responde ÚNICAMENTE con un objeto JSON (sin markdown, sin texto extra) con EXACTAMENTE estas claves:
{
  "es_comprobante": boolean,   // true solo si la imagen es un comprobante de pago/transferencia/depósito
  "monto": number | null,      // monto pagado, solo el número (ej. 350.00)
  "moneda": string | null,     // "MXN", "USD", etc.
  "fecha": string | null,      // fecha del pago tal como aparece
  "banco": string | null,      // banco o app emisora (ej. "BBVA")
  "referencia": string | null, // folio, clave de rastreo o referencia
  "titular": string | null,    // nombre del ordenante/emisor si es visible
  "descripcion": string        // una frase corta describiendo qué se ve
}

Extrae SOLO lo que sea claramente legible en la imagen; usa null para lo que no se vea. Nunca inventes datos.`

// ------------------------------------------------------------
// Descarga de la imagen
// ------------------------------------------------------------

/** Firma mágica → media type, para cuando el CDN no manda Content-Type. */
function sniffMediaType(bytes: Uint8Array): string | null {
  if (bytes.length < 12) return null
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg'
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e) return 'image/png'
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif'
  if (
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return 'image/webp'
  }
  return null
}

async function downloadImage(
  url: string,
  timeoutMs: number,
): Promise<{ base64: string; mediaType: string } | null> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) return null

  const declaredLength = Number(res.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_IMAGE_BYTES) return null

  const buf = new Uint8Array(await res.arrayBuffer())
  if (buf.byteLength === 0 || buf.byteLength > MAX_IMAGE_BYTES) return null

  const declared = (res.headers.get('content-type') ?? '').split(';')[0].trim()
  const mediaType = SUPPORTED_MEDIA_TYPES.has(declared)
    ? declared
    : (sniffMediaType(buf) ?? (declared.startsWith('image/') ? 'image/jpeg' : null))
  if (!mediaType) return null

  return { base64: Buffer.from(buf).toString('base64'), mediaType }
}

// ------------------------------------------------------------
// Llamadas de visión por proveedor
// ------------------------------------------------------------

// Con holgura para modelos de razonamiento (o4-mini): los tokens de
// razonamiento cuentan contra el máximo (ver loop-openai.ts).
const VISION_MAX_TOKENS = 2048

async function callOpenAiVision(
  apiKey: string,
  model: string,
  image: { base64: string; mediaType: string },
  timeoutMs: number,
): Promise<string | null> {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: EXTRACTION_PROMPT },
            {
              type: 'image_url',
              image_url: { url: `data:${image.mediaType};base64,${image.base64}` },
            },
          ],
        },
      ],
      max_completion_tokens: VISION_MAX_TOKENS,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) return null
  const data = (await res.json().catch(() => ({}))) as {
    choices?: { message?: { content?: string | null } }[]
  }
  return data.choices?.[0]?.message?.content ?? null
}

async function callAnthropicVision(
  apiKey: string,
  model: string,
  image: { base64: string; mediaType: string },
  timeoutMs: number,
): Promise<string | null> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: VISION_MAX_TOKENS,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: image.mediaType,
                data: image.base64,
              },
            },
            { type: 'text', text: EXTRACTION_PROMPT },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) return null
  const data = (await res.json().catch(() => ({}))) as {
    content?: { type: string; text?: string }[]
  }
  return (
    (data.content ?? [])
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('') || null
  )
}

// ------------------------------------------------------------
// Parseo del JSON del modelo
// ------------------------------------------------------------

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

/** Tolera fences de markdown y texto alrededor del objeto JSON. */
export function parseReceiptAnalysis(raw: string): ReceiptAnalysis | null {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>
  } catch {
    return null
  }
  const monto = Number(parsed.monto)
  return {
    esComprobante: parsed.es_comprobante === true,
    monto: Number.isFinite(monto) && monto > 0 ? monto : null,
    moneda: str(parsed.moneda),
    fecha: str(parsed.fecha),
    banco: str(parsed.banco),
    referencia: str(parsed.referencia),
    titular: str(parsed.titular),
    descripcion: str(parsed.descripcion),
  }
}

export interface AnalyzeImageArgs {
  provider: AiProvider
  apiKey: string
  model: string
  imageUrl: string
}

/**
 * Descarga la imagen y extrae los datos del comprobante con el
 * proveedor configurado. null = no se pudo (el llamador inyecta la nota
 * de "imagen sin analizar" y el flujo sigue). Nunca lanza.
 */
export async function analyzeReceiptImage(
  args: AnalyzeImageArgs,
): Promise<ReceiptAnalysis | null> {
  try {
    const timeoutMs = aiRequestTimeoutMs()
    const image = await downloadImage(args.imageUrl, timeoutMs)
    if (!image) return null

    const raw =
      args.provider === 'openai'
        ? await callOpenAiVision(args.apiKey, args.model, image, timeoutMs)
        : await callAnthropicVision(args.apiKey, args.model, image, timeoutMs)
    if (!raw) return null

    return parseReceiptAnalysis(raw)
  } catch (err) {
    console.error('[agent vision] receipt analysis failed:', err)
    return null
  }
}

// ------------------------------------------------------------
// Nota para el transcript del agente
// ------------------------------------------------------------

/**
 * Nota (solo DATOS — la política de qué hacer con ellos vive en el
 * SCAFFOLD del prompt) que se inyecta como turno de usuario al final
 * del transcript. El marcador fijo permite que el prompt le enseñe al
 * modelo a distinguir la nota legítima de un paciente que la imite.
 */
export function buildReceiptNote(analysis: ReceiptAnalysis | null): string {
  const header =
    '[Nota automática del sistema — análisis de la imagen que envió el paciente. El paciente no ve esta nota.]'
  if (!analysis) {
    return `${header}\nNo se pudo analizar la imagen automáticamente. La imagen queda guardada en la conversación para que el equipo la revise en el panel.`
  }
  const lines = [header, `Es comprobante de pago: ${analysis.esComprobante ? 'sí' : 'no'}`]
  if (analysis.monto != null) {
    lines.push(`Monto: ${analysis.monto}${analysis.moneda ? ` ${analysis.moneda}` : ''}`)
  }
  if (analysis.fecha) lines.push(`Fecha del pago: ${analysis.fecha}`)
  if (analysis.banco) lines.push(`Banco emisor: ${analysis.banco}`)
  if (analysis.referencia) lines.push(`Referencia/folio: ${analysis.referencia}`)
  if (analysis.titular) lines.push(`Ordenante: ${analysis.titular}`)
  if (analysis.descripcion) lines.push(`Qué se ve: ${analysis.descripcion}`)
  return lines.join('\n')
}

// ------------------------------------------------------------
// Imágenes recientes sin responder → notas para la corrida
// ------------------------------------------------------------

/** Solo analizamos imágenes de la ráfaga actual, no fotos viejas. */
const RECENT_IMAGE_WINDOW_MS = 60 * 60 * 1000
/** Máximo de imágenes a analizar por corrida (comprobante + detalle). */
const MAX_IMAGES_PER_RUN = 2

export interface RecentImageNotesArgs {
  db: SupabaseClient
  conversationId: string
  provider: AiProvider
  apiKey: string
  model: string
  now: Date
}

/**
 * Busca las imágenes que el paciente envió DESPUÉS de la última
 * respuesta nuestra (bot o humano) y dentro de la última hora — es
 * decir, las de la ráfaga que está por responderse — y devuelve una
 * nota de análisis por imagen (orden cronológico). Best-effort: [] si
 * no hay imágenes o algo falla.
 */
export async function buildRecentImageNotes(
  args: RecentImageNotesArgs,
): Promise<string[]> {
  try {
    const { db, conversationId, now } = args

    const { data: lastReply } = await db
      .from('messages')
      .select('created_at')
      .eq('conversation_id', conversationId)
      .in('sender_type', ['bot', 'agent'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    const windowStart = new Date(now.getTime() - RECENT_IMAGE_WINDOW_MS).toISOString()
    const lastReplyAt = (lastReply?.created_at as string | null) ?? null
    const cutoff =
      lastReplyAt && lastReplyAt > windowStart ? lastReplyAt : windowStart

    const { data: images } = await db
      .from('messages')
      .select('media_url, created_at')
      .eq('conversation_id', conversationId)
      .eq('sender_type', 'customer')
      .eq('content_type', 'image')
      .not('media_url', 'is', null)
      .gt('created_at', cutoff)
      .order('created_at', { ascending: false })
      .limit(MAX_IMAGES_PER_RUN)

    if (!images || images.length === 0) return []

    const chronological = [...images].reverse()
    const notes: string[] = []
    for (const img of chronological) {
      const analysis = await analyzeReceiptImage({
        provider: args.provider,
        apiKey: args.apiKey,
        model: args.model,
        imageUrl: img.media_url as string,
      })
      notes.push(buildReceiptNote(analysis))
    }
    return notes
  } catch (err) {
    console.error('[agent vision] recent-image scan failed:', err)
    return []
  }
}
