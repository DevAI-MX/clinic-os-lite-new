// ============================================================
// clinicOS — herramientas del agente Concierge (doctor/equipo).
//
// Tercer catálogo del sistema (junto a CLINICAL_TOOLS de Sofía y
// INTERNAL_TOOLS del asistente de solo-lectura). El Concierge opera a
// escala de CUENTA (no de un contacto) y se divide en dos clases:
//
//   * Lectura  — ejecutan directo con el cliente RLS del usuario.
//   * Escritura — NUNCA mutan nada al ser llamadas: crean una fila en
//     assistant_actions (status 'proposed') y la UI pinta una tarjeta
//     de confirmación. Solo executeConfirmedAction() (actions.ts) las
//     ejecuta, tras el clic de "Confirmar" del humano. Así la regla de
//     oro (pagos/citas los decide un humano) se conserva: la
//     confirmación del usuario del chat ES la decisión humana.
//
// A diferencia de las tools internas viejas, las de lectura DEVUELVEN
// IDS (contact_id, appointment_id, payment_id, deal_id…) porque las
// tools de escritura los necesitan como referencia.
// ============================================================

import type { ToolDefinition } from '../agent'
import { APPOINTMENT_TYPES, RECORD_CATEGORIES } from '../agent/tools'

/** Estados que el equipo puede fijar en una cita desde el Concierge.
 *  ('pendiente' no está: esa la deja el agente de WhatsApp; el humano
 *  solo avanza o cancela.) */
export const CONCIERGE_APPT_STATUSES = [
  'confirmada',
  'completada',
  'cancelada',
  'no_asistio',
] as const

export const CONCIERGE_READ_TOOLS: readonly ToolDefinition[] = [
  {
    name: 'consultar_agenda_dia',
    description:
      'Devuelve las citas agendadas para un día (id de cita, paciente, hora, tipo, estado y anticipo). Úsala para "qué tengo hoy/mañana", "cuántas citas hay el viernes", y SIEMPRE antes de proponer cambios sobre una cita para tener su appointment_id real.',
    input_schema: {
      type: 'object',
      properties: {
        fecha: {
          type: 'string',
          description: 'Fecha en formato YYYY-MM-DD, hora local de la clínica. Omítela para hoy.',
        },
      },
    },
  },
  {
    name: 'consultar_anticipos_pendientes',
    description:
      'Devuelve los anticipos que el equipo aún no confirma (payment_id, paciente, monto, método, comprobante y cita asociada). Úsala para "qué anticipos faltan por revisar" y antes de proponer validar_anticipo.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'consultar_embudo',
    description:
      'Devuelve el embudo de IA por etapas (stage_id y nombre) con sus leads (deal_id, título, valor). Úsala para "cómo va el embudo" y antes de proponer mover_deal.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'buscar_paciente',
    description:
      'Busca un paciente/contacto por nombre o teléfono y devuelve su contact_id, datos, citas recientes (con appointment_id) y expediente clínico ligero. Úsala para "qué sabemos de [nombre]" y antes de proponer acciones sobre un paciente.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Nombre (parcial) o teléfono a buscar.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'consultar_disponibilidad',
    description:
      'Devuelve los próximos huecos LIBRES de la agenda (ya descuenta horario, bloqueos y citas). Úsala SIEMPRE antes de proponer agendar_cita o reagendar_cita para no encimar citas.',
    input_schema: {
      type: 'object',
      properties: {
        desde: {
          type: 'string',
          description: 'Fecha (YYYY-MM-DD, hora local) desde la cual buscar. Omítela para empezar desde ahora.',
        },
        dias: {
          type: 'integer',
          description: 'Cuántos días hacia adelante explorar (default 7, máx 30).',
        },
        duracion_minutos: {
          type: 'integer',
          description: 'Duración que necesita la cita. Omítela si pasas procedure_id.',
        },
        procedure_id: {
          type: 'string',
          description: 'ID del procedimiento (del catálogo) para tomar su duración.',
        },
      },
    },
  },
  {
    name: 'consultar_catalogo',
    description:
      'Devuelve el catálogo vivo de procedimientos/servicios (id, precios, anticipo, duración). Úsala antes de citar un precio o de proponer una cita con procedimiento.',
    input_schema: {
      type: 'object',
      properties: {
        categoria: {
          type: 'string',
          description: 'Filtro opcional por categoría. Omítela para ver todo.',
        },
      },
    },
  },
]

export const CONCIERGE_WRITE_TOOLS: readonly ToolDefinition[] = [
  {
    name: 'agendar_cita',
    description:
      'PROPONE crear una cita para un paciente. No la crea: muestra una tarjeta que el usuario debe confirmar. Consulta antes buscar_paciente (contact_id) y consultar_disponibilidad (hueco libre). Si el procedimiento requiere anticipo, la cita quedará pendiente de anticipo como en el panel.',
    input_schema: {
      type: 'object',
      properties: {
        contact_id: {
          type: 'string',
          description: 'ID del contacto/paciente (de buscar_paciente).',
        },
        inicio: {
          type: 'string',
          description: 'Inicio de la cita: hueco de consultar_disponibilidad (ISO 8601) u hora local "YYYY-MM-DDTHH:MM".',
        },
        tipo: {
          type: 'string',
          enum: [...APPOINTMENT_TYPES],
          description: 'Tipo de cita. Default "valoracion".',
        },
        procedure_id: {
          type: 'string',
          description: 'ID del procedimiento del catálogo (define duración y anticipo).',
        },
        notas: {
          type: 'string',
          description: 'Notas internas para el equipo.',
        },
      },
      required: ['contact_id', 'inicio'],
    },
  },
  {
    name: 'reagendar_cita',
    description:
      'PROPONE mover una cita existente a otra fecha/hora. No la mueve: muestra una tarjeta que el usuario debe confirmar. Consulta antes la cita (consultar_agenda_dia o buscar_paciente) para el appointment_id y consultar_disponibilidad para el hueco nuevo.',
    input_schema: {
      type: 'object',
      properties: {
        appointment_id: {
          type: 'string',
          description: 'ID de la cita a mover.',
        },
        inicio: {
          type: 'string',
          description: 'Nuevo inicio: hueco de consultar_disponibilidad (ISO) u hora local "YYYY-MM-DDTHH:MM".',
        },
      },
      required: ['appointment_id', 'inicio'],
    },
  },
  {
    name: 'actualizar_estado_cita',
    description:
      'PROPONE cambiar el estado de una cita (confirmada, completada, cancelada, no_asistio). No lo cambia: muestra una tarjeta que el usuario debe confirmar.',
    input_schema: {
      type: 'object',
      properties: {
        appointment_id: {
          type: 'string',
          description: 'ID de la cita.',
        },
        estado: {
          type: 'string',
          enum: [...CONCIERGE_APPT_STATUSES],
          description: 'Estado nuevo de la cita.',
        },
      },
      required: ['appointment_id', 'estado'],
    },
  },
  {
    name: 'validar_anticipo',
    description:
      'PROPONE confirmar un anticipo pendiente (el pago pasa a confirmado y la cita a anticipo pagado). No lo confirma: muestra una tarjeta con monto y comprobante que el usuario debe revisar y confirmar. Consulta antes consultar_anticipos_pendientes para el payment_id.',
    input_schema: {
      type: 'object',
      properties: {
        payment_id: {
          type: 'string',
          description: 'ID del pago pendiente (de consultar_anticipos_pendientes).',
        },
      },
      required: ['payment_id'],
    },
  },
  {
    name: 'mover_deal',
    description:
      'PROPONE mover un lead/deal a otra etapa del embudo. No lo mueve: muestra una tarjeta que el usuario debe confirmar. Consulta antes consultar_embudo para deal_id y stage_id.',
    input_schema: {
      type: 'object',
      properties: {
        deal_id: {
          type: 'string',
          description: 'ID del deal a mover.',
        },
        stage_id: {
          type: 'string',
          description: 'ID de la etapa destino (de consultar_embudo).',
        },
      },
      required: ['deal_id', 'stage_id'],
    },
  },
  {
    name: 'crear_nota_paciente',
    description:
      'PROPONE agregar una entrada al expediente ligero de un paciente (nota del equipo). No la crea: muestra una tarjeta que el usuario debe confirmar.',
    input_schema: {
      type: 'object',
      properties: {
        contact_id: {
          type: 'string',
          description: 'ID del contacto/paciente.',
        },
        categoria: {
          type: 'string',
          enum: [...RECORD_CATEGORIES],
          description: 'Categoría del dato. Default "nota".',
        },
        dato: {
          type: 'string',
          description: 'El dato a registrar, corto (máx 500 caracteres).',
        },
      },
      required: ['contact_id', 'dato'],
    },
  },
]

export const CONCIERGE_TOOLS: readonly ToolDefinition[] = [
  ...CONCIERGE_READ_TOOLS,
  ...CONCIERGE_WRITE_TOOLS,
]

export type ConciergeWriteToolName =
  | 'agendar_cita'
  | 'reagendar_cita'
  | 'actualizar_estado_cita'
  | 'validar_anticipo'
  | 'mover_deal'
  | 'crear_nota_paciente'

export const CONCIERGE_WRITE_TOOL_NAMES: readonly ConciergeWriteToolName[] = [
  'agendar_cita',
  'reagendar_cita',
  'actualizar_estado_cita',
  'validar_anticipo',
  'mover_deal',
  'crear_nota_paciente',
]

/** Etiqueta de actividad que la UI muestra mientras corre cada tool. */
export const TOOL_STATUS_LABEL: Record<string, string> = {
  consultar_agenda_dia: 'Consultando agenda…',
  consultar_anticipos_pendientes: 'Revisando anticipos…',
  consultar_embudo: 'Consultando el embudo…',
  buscar_paciente: 'Buscando paciente…',
  consultar_disponibilidad: 'Buscando huecos libres…',
  consultar_catalogo: 'Consultando catálogo…',
  agendar_cita: 'Preparando propuesta de cita…',
  reagendar_cita: 'Preparando reagendado…',
  actualizar_estado_cita: 'Preparando cambio de estado…',
  validar_anticipo: 'Preparando validación de anticipo…',
  mover_deal: 'Preparando movimiento en el embudo…',
  crear_nota_paciente: 'Preparando nota de expediente…',
}
