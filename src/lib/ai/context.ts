import type { SupabaseClient } from '@supabase/supabase-js'
import type { ChatMessage } from './types'
import { aiContextMessageLimit } from './defaults'

interface DbMessage {
  sender_type: 'customer' | 'agent' | 'bot'
  content_type: string
  content_text: string | null
}

/** Etiqueta en español del marcador de un mensaje multimedia. */
const MEDIA_LABEL: Record<string, string> = {
  image: 'una imagen',
  document: 'un documento',
  audio: 'un mensaje de voz',
  video: 'un video',
}

/**
 * Marcador que antecede a los mensajes escritos por una PERSONA del
 * equipo (sender_type='agent', modo humano/panel) en el transcript del
 * agente clínico. Sin él, el modelo no distingue sus propios mensajes
 * de los del equipo y puede contradecirlos (incidente 2026-07-08: un
 * humano confirmó un pago por chat y la IA respondió después "sigue en
 * revisión"). Solo lo escribimos NOSOTROS desde sender_type de la BD:
 * un paciente no puede forjarlo como mensaje del equipo porque sus
 * mensajes siempre viajan con rol `user`.
 */
export const TEAM_PREFIX = '[Equipo]: '

interface BuildContextOpts {
  /**
   * Antepone TEAM_PREFIX a los mensajes de texto del equipo humano.
   * Lo activa la rama clínica (Sofía), cuyo prompt explica el marcador;
   * el resto de consumidores conserva el transcript de siempre.
   */
  markTeamMessages?: boolean
}

/**
 * Marcador textual de un mensaje multimedia para el transcript. Sin
 * esto el modelo era ciego a que el paciente mandó algo (p. ej. el
 * comprobante del anticipo llegaba y el agente ni se enteraba); el
 * contenido de la imagen en sí lo aporta el paso de visión
 * (agent/vision.ts) como nota aparte.
 */
function mediaPlaceholder(m: DbMessage, markTeam: boolean): string {
  const label = MEDIA_LABEL[m.content_type]
  const caption = m.content_text?.trim()
  const base =
    m.sender_type === 'customer'
      ? `[El paciente envió ${label}`
      : markTeam && m.sender_type === 'agent'
        ? `[El equipo envió ${label}`
        : `[Enviaste ${label}`
  return caption ? `${base} con el texto: "${caption}"]` : `${base}]`
}

/**
 * Fetch the last N messages of a conversation and map them to the
 * provider-neutral chat shape. Customer messages become `user`; agent
 * and bot messages become `assistant`. Media messages (image, document,
 * audio, video) become a bracketed placeholder so the model knows they
 * happened; template/interactive/location rows are still excluded.
 *
 * Ordered oldest-first (chronological) so the transcript reads
 * naturally and the most recent customer message lands last.
 */
export async function buildConversationContext(
  db: SupabaseClient,
  conversationId: string,
  limit: number = aiContextMessageLimit(),
  opts: BuildContextOpts = {},
): Promise<ChatMessage[]> {
  const { data, error } = await db
    .from('messages')
    .select('sender_type, content_type, content_text')
    .eq('conversation_id', conversationId)
    .in('content_type', ['text', ...Object.keys(MEDIA_LABEL)])
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) throw error

  const markTeam = opts.markTeamMessages === true
  const rows = ((data ?? []) as DbMessage[]).reverse()
  const out: ChatMessage[] = []
  for (const m of rows) {
    const role = m.sender_type === 'customer' ? ('user' as const) : ('assistant' as const)
    if (m.content_type === 'text') {
      if (m.content_text && m.content_text.trim()) {
        const text = m.content_text.trim()
        out.push({
          role,
          content:
            markTeam && m.sender_type === 'agent' ? `${TEAM_PREFIX}${text}` : text,
        })
      }
    } else if (MEDIA_LABEL[m.content_type]) {
      out.push({ role, content: mediaPlaceholder(m, markTeam) })
    }
  }
  return out
}

/**
 * Textos escritos por el equipo humano dentro del transcript ya
 * construido con `markTeamMessages` (sin el marcador). Son evidencia
 * confiable para el guardrail: salen de sender_type='agent' de la BD,
 * que un paciente no puede forjar.
 */
export function teamMessageTexts(messages: ChatMessage[]): string[] {
  return messages
    .filter((m) => m.role === 'assistant' && m.content.startsWith(TEAM_PREFIX))
    .map((m) => m.content.slice(TEAM_PREFIX.length))
}

/**
 * Último mensaje que el paciente YA recibió de nosotros (bot o equipo),
 * sin el marcador. Lo consume el candado anti-repetición del guardrail:
 * re-enviarle al paciente (casi) el mismo texto es señal de que el
 * modelo no atendió su respuesta (incidente 2026-07-08: repitió la
 * lista de horarios cuando el paciente ya había aceptado uno).
 */
export function lastAssistantText(messages: ChatMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== 'assistant') continue
    return m.content.startsWith(TEAM_PREFIX)
      ? m.content.slice(TEAM_PREFIX.length)
      : m.content
  }
  return null
}
