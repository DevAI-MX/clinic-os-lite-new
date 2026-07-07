// ============================================================
// clinicOS — bloques estructurados del Concierge.
//
// Un bloque es un resultado tipado que el ejecutor de tools emite al
// stream NDJSON (evento 'block') para que la UI pinte un widget rico
// (tabla de agenda, chip de navegación…) SIN parsear el texto del
// modelo. Se persisten en assistant_messages.content_json.blocks para
// que el historial los re-pinte igual.
//
// Este archivo solo define tipos y constantes: lo importan el servidor
// (execute.ts, chat route) y el cliente (chat-thread) sin arrastrar
// dependencias de ninguno de los dos lados.
// ============================================================

/** Una cita dentro del bloque de agenda. `estado`/`anticipo_estado`
 *  traen el valor crudo de BD (para colorear chips); las etiquetas
 *  legibles van aparte. */
export interface AgendaBlockCita {
  appointment_id: string
  contact_id: string
  paciente: string
  hora: string
  tipo: string | null
  /** Crudo: pendiente | confirmada | completada | cancelada | no_asistio */
  estado: string
  estado_label: string
  /** Crudo: no_aplica | pendiente | pagado */
  anticipo_estado: string
  anticipo: string
}

/** Widget de agenda de un día — lo emite consultar_agenda_dia. */
export interface AgendaBlock {
  kind: 'agenda'
  /** Día consultado, YYYY-MM-DD en hora local de la clínica. */
  fecha: string
  citas: AgendaBlockCita[]
}

/** Chip de navegación — lo emite abrir_seccion. El cliente, al recibirlo
 *  EN VIVO, además navega a `href`; hidratado desde historial solo pinta
 *  el chip (no re-navega). */
export interface NavigateBlock {
  kind: 'navegacion'
  seccion: string
  href: string
  label: string
}

export type ConciergeBlock = AgendaBlock | NavigateBlock

/** Secciones del panel que el Concierge puede abrir con abrir_seccion.
 *  Allow-list cerrada: el modelo elige una clave, nunca un href libre. */
export const CONCIERGE_SECTIONS = {
  calendario: { href: '/calendario', label: 'Calendario' },
  conversaciones: { href: '/inbox', label: 'Conversaciones' },
  crm: { href: '/contacts', label: 'CRM' },
  embudo: { href: '/pipelines', label: 'Embudo' },
  notificaciones: { href: '/notifications', label: 'Notificaciones' },
} as const

export type ConciergeSectionKey = keyof typeof CONCIERGE_SECTIONS

export const CONCIERGE_SECTION_KEYS = Object.keys(
  CONCIERGE_SECTIONS,
) as ConciergeSectionKey[]
