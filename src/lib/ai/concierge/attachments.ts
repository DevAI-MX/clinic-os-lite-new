// ============================================================
// clinicOS — adjuntos del Concierge (imágenes y PDF en el chat).
//
// El cliente sube el archivo al bucket público `chat-media` (misma
// convención account-scoped del inbox, migración 023) y manda al turno
// solo { url, mime, name }. Aquí se valida esa referencia (allow-list
// de mimes y URL anclada a NUESTRO storage — nunca se descarga una URL
// arbitraria: eso sería SSRF) y se convierte en notas de texto para el
// modelo: las imágenes pasan por el MISMO análisis de visión que usa
// Sofía para comprobantes (analyzeReceiptImage — extrae monto/banco/
// referencia si es un pago, y una descripción si no); los PDF solo se
// anuncian por nombre (el modelo no puede leerlos aún).
// ============================================================

import type { AiProvider } from '../types'
import { analyzeReceiptImage, type ReceiptAnalysis } from '../agent'

export interface ConciergeAttachment {
  url: string
  mime: string
  name: string
}

/** Tope de adjuntos por turno (la UI también lo aplica). */
export const MAX_ATTACHMENTS_PER_TURN = 3
/** Cuántas imágenes se analizan con visión por turno (costo acotado). */
const MAX_IMAGES_ANALYZED = 2

export const ATTACHMENT_IMAGE_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
])
export const ATTACHMENT_MIMES = new Set([
  ...ATTACHMENT_IMAGE_MIMES,
  'application/pdf',
])

/**
 * Valida el payload `attachments` del body del chat. Devuelve la lista
 * normalizada, o null si el payload es inválido (el route responde 400).
 * `storageBase` ancla las URLs a nuestro bucket público — p.ej.
 * `${SUPABASE_URL}/storage/v1/object/public/chat-media/`.
 */
export function parseAttachments(
  raw: unknown,
  storageBase: string,
): ConciergeAttachment[] | null {
  if (raw == null) return []
  if (!Array.isArray(raw) || raw.length > MAX_ATTACHMENTS_PER_TURN) return null
  if (!storageBase) return null

  const out: ConciergeAttachment[] = []
  for (const item of raw) {
    const url = typeof (item as { url?: unknown })?.url === 'string' ? (item as { url: string }).url : ''
    const mime = typeof (item as { mime?: unknown })?.mime === 'string' ? (item as { mime: string }).mime : ''
    const name = typeof (item as { name?: unknown })?.name === 'string' ? (item as { name: string }).name : ''
    if (!url.startsWith(storageBase)) return null
    if (!ATTACHMENT_MIMES.has(mime)) return null
    out.push({ url, mime, name: (name || 'archivo').slice(0, 120) })
  }
  return out
}

/**
 * Nota de sistema para UN adjunto. Pura (testeable): recibe el análisis
 * ya hecho (o null si la visión falló / no se corrió).
 */
export function buildAttachmentNote(
  att: ConciergeAttachment,
  analysis: ReceiptAnalysis | null,
): string {
  if (att.mime === 'application/pdf') {
    return `[Nota automática del sistema — el usuario adjuntó el documento PDF "${att.name}". No puedes leer su contenido todavía; si necesitas datos de ese documento, pídeselos al usuario.]`
  }
  const header = `[Nota automática del sistema — análisis de la imagen "${att.name}" que el usuario adjuntó al chat. El análisis es automático: verifica los datos críticos con el usuario antes de proponer acciones.]`
  if (!analysis) {
    return `${header}\nNo se pudo analizar la imagen automáticamente. Está visible en el chat; pide al usuario los datos que necesites.`
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

export interface BuildAttachmentNotesArgs {
  attachments: ConciergeAttachment[]
  provider: AiProvider
  apiKey: string
  model: string
}

/**
 * Convierte los adjuntos del turno en notas para el modelo. Best-effort:
 * la visión que falle degrada a "imagen sin analizar" y el turno sigue.
 */
export async function buildAttachmentNotes(
  args: BuildAttachmentNotesArgs,
): Promise<string[]> {
  const notes: string[] = []
  let analyzed = 0
  for (const att of args.attachments) {
    if (ATTACHMENT_IMAGE_MIMES.has(att.mime) && analyzed < MAX_IMAGES_ANALYZED) {
      analyzed += 1
      const analysis = await analyzeReceiptImage({
        provider: args.provider,
        apiKey: args.apiKey,
        model: args.model,
        imageUrl: att.url,
      })
      notes.push(buildAttachmentNote(att, analysis))
    } else {
      notes.push(buildAttachmentNote(att, null))
    }
  }
  return notes
}
