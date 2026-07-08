// ============================================================
// clinicOS — snapshot del estado real del paciente para el prompt.
//
// Cada corrida del agente arranca sin memoria de las tools de corridas
// anteriores (los tool_results no se persisten en `messages`), así que
// el modelo solo "sabe" lo que se lee en el chat. Eso producía dos
// fallas vistas en producción (incidente Acerotech): re-preguntar un
// horario ya acordado y contradecir la disponibilidad que él mismo
// había ofrecido. Este snapshot inyecta, en cada corrida, lo que la BD
// dice HOY: si hay cita apartada (y su anticipo) o no la hay.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { formatSlotLabel } from './clinic-time'

export interface PatientStateArgs {
  db: SupabaseClient
  accountId: string
  contactId: string
  timezone: string
  now: Date
}

function money(amount: number, currency = 'MXN'): string {
  return new Intl.NumberFormat('es-MX', {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  }).format(amount)
}

/**
 * Líneas de estado para la sección "# Estado real del paciente" del
 * system prompt. Best-effort: cualquier error devuelve [] — el agente
 * corre igual que antes, solo que sin snapshot.
 */
export async function buildPatientStateLines(
  args: PatientStateArgs,
): Promise<string[]> {
  const { db, accountId, contactId, timezone, now } = args
  try {
    const [apptRes, paymentRes] = await Promise.all([
      db
        .from('appointments')
        .select('starts_at, status, deposit_status, deposit_amount')
        .eq('account_id', accountId)
        .eq('contact_id', contactId)
        .in('status', ['pendiente', 'confirmada'])
        .gt('ends_at', now.toISOString())
        .order('starts_at', { ascending: true })
        .limit(1)
        .maybeSingle(),
      db
        .from('payments')
        .select('amount, currency, status')
        .eq('account_id', accountId)
        .eq('contact_id', contactId)
        .eq('status', 'pendiente')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
    ])

    const lines: string[] = []
    const appt = apptRes.data
    if (appt) {
      const label = formatSlotLabel(new Date(appt.starts_at), timezone)
      const estado =
        appt.status === 'confirmada' ? 'confirmada' : 'pendiente de confirmar'
      const dep = Number(appt.deposit_amount)
      const anticipo =
        appt.deposit_status === 'pagado'
          ? 'anticipo pagado'
          : appt.deposit_status === 'pendiente'
            ? `anticipo pendiente${Number.isFinite(dep) && dep > 0 ? ` (${money(dep)})` : ''}`
            : 'sin anticipo requerido'
      lines.push(`Cita apartada: ${label} — ${estado}, ${anticipo}.`)
    } else {
      lines.push(
        'El paciente NO tiene ninguna cita apartada en el sistema. Si en la conversación ya acordaron un horario, NO está agendado: apártalo con agendar_cita ahora.',
      )
    }

    const payment = paymentRes.data
    if (payment) {
      const amt = Number(payment.amount)
      lines.push(
        `Hay un anticipo de ${Number.isFinite(amt) ? money(amt, payment.currency ?? 'MXN') : 'monto por confirmar'} EN REVISIÓN del equipo — no le vuelvas a pedir el pago; dile que le avisas al confirmarse.`,
      )
    }

    return lines
  } catch {
    return []
  }
}

export interface ReceptionFlowArgs extends PatientStateArgs {
  /** Nombre registrado en el CRM (el caller ya lo leyó); null si no hay. */
  contactName: string | null
}

interface FlowAppointment {
  starts_at: string
  status: string
  deposit_status: string | null
  deposit_amount: unknown
  procedure_id: string | null
  appointment_type: string | null
}

/**
 * Checklist del flujo de recepción para la sección "# Progreso del
 * flujo de recepción" del system prompt. Es el equivalente WhatsApp de
 * un formulario multi-step: cinco pasos (servicio → cita → datos →
 * anticipo → confirmación del equipo) con su estado REAL.
 *
 * Solo marca como hecho lo que la BD confirma (appointments, payments,
 * contacts, procedures); lo que vive únicamente en la conversación
 * (p. ej. un horario aceptado que aún no se aparta) se deja como
 * instrucción explícita para el modelo, nunca como hecho. Best-effort:
 * cualquier error devuelve [] y el agente corre igual.
 */
export async function buildReceptionFlowLines(
  args: ReceptionFlowArgs,
): Promise<string[]> {
  const { db, accountId, contactId, contactName, timezone, now } = args
  try {
    const [apptRes, paymentRes] = await Promise.all([
      db
        .from('appointments')
        .select('starts_at, status, deposit_status, deposit_amount, procedure_id, appointment_type')
        .eq('account_id', accountId)
        .eq('contact_id', contactId)
        .in('status', ['pendiente', 'confirmada'])
        .gt('ends_at', now.toISOString())
        .order('starts_at', { ascending: true })
        .limit(1)
        .maybeSingle(),
      db
        .from('payments')
        .select('amount, currency, status')
        .eq('account_id', accountId)
        .eq('contact_id', contactId)
        .eq('status', 'pendiente')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
    ])

    const appt = (apptRes.data as FlowAppointment | null) ?? null
    const payment = paymentRes.data

    let procedureName: string | null = null
    if (appt?.procedure_id) {
      const { data: proc } = await db
        .from('procedures')
        .select('name')
        .eq('account_id', accountId)
        .eq('id', appt.procedure_id)
        .maybeSingle()
      procedureName = (proc?.name as string | null) ?? null
    }

    const lines: string[] = []

    // Paso 1 — servicio. Solo la cita apartada (con su procedimiento)
    // lo confirma; lo hablado en el chat no cuenta como hecho.
    if (appt && procedureName) {
      lines.push(`1. Servicio: confirmado en el sistema — "${procedureName}".`)
    } else if (appt) {
      lines.push(
        `1. Servicio: la cita apartada es de tipo "${appt.appointment_type ?? 'valoracion'}" sin procedimiento ligado.`,
      )
    } else {
      lines.push(
        '1. Servicio: sin confirmar en el sistema — identifícalo en la conversación (consulta el catálogo antes de cotizar).',
      )
    }

    // Paso 2 — cita.
    if (appt) {
      const label = formatSlotLabel(new Date(appt.starts_at), timezone)
      const estado =
        appt.status === 'confirmada'
          ? 'confirmada'
          : 'pendiente de que el equipo la confirme'
      lines.push(`2. Cita: apartada en el sistema para ${label} (${estado}).`)
    } else {
      lines.push(
        '2. Cita: NO hay ninguna cita apartada en el sistema. Si en la conversación el paciente YA aceptó un horario, apártalo con agendar_cita en este mismo turno; si no, pide u ofrece horario (consultar_disponibilidad).',
      )
    }

    // Paso 3 — datos mínimos (el CRM es la fuente, no la conversación).
    lines.push(
      contactName
        ? `3. Datos del paciente: nombre registrado — ${contactName}.`
        : '3. Datos del paciente: sin nombre registrado. Pídelo pronto y guárdalo con clasificar_lead.',
    )

    // Paso 4 — anticipo.
    const depositAmt = Number(appt?.deposit_amount)
    const depositLabel =
      Number.isFinite(depositAmt) && depositAmt > 0 ? ` (${money(depositAmt)})` : ''
    if (payment) {
      const amt = Number(payment.amount)
      lines.push(
        `4. Anticipo: comprobante EN REVISIÓN del equipo${
          Number.isFinite(amt) ? ` — ${money(amt, payment.currency ?? 'MXN')}` : ''
        }. No le vuelvas a pedir el pago.`,
      )
    } else if (!appt) {
      lines.push(
        '4. Anticipo: aplica DESPUÉS de apartar la cita — no pidas pago antes de agendar.',
      )
    } else if (appt.deposit_status === 'pagado') {
      lines.push('4. Anticipo: pagado.')
    } else if (appt.deposit_status === 'pendiente') {
      lines.push(
        `4. Anticipo: PENDIENTE${depositLabel} — sin este paso la cita no se confirma.`,
      )
    } else {
      lines.push('4. Anticipo: no aplica para esta cita.')
    }

    // Paso 5 — siguiente acción, derivada solo de los hechos de arriba.
    if (payment) {
      lines.push(
        '5. Siguiente paso: esperar la validación del equipo. Atiende otras dudas sin volver a cobrar; le avisas al paciente cuando el equipo lo confirme.',
      )
    } else if (appt && appt.deposit_status === 'pendiente') {
      lines.push(
        '5. Siguiente paso: conseguir el comprobante del anticipo (comparte los datos de consultar_datos_pago) y prevalidarlo con prevalidar_anticipo.',
      )
    } else if (appt && appt.status === 'confirmada') {
      lines.push(
        '5. Siguiente paso: nada pendiente — la cita quedó lista. Atiende dudas y recuérdale su cita si pregunta.',
      )
    } else if (appt) {
      lines.push(
        '5. Siguiente paso: el equipo revisará y confirmará la cita en el panel. Atiende dudas; no la muevas salvo que el paciente lo pida.',
      )
    } else if (!contactName) {
      lines.push(
        '5. Siguiente paso: atiende su duda, captura su nombre y llévalo a apartar una valoración.',
      )
    } else {
      lines.push(
        '5. Siguiente paso: llévalo a elegir horario — ofrece huecos con consultar_disponibilidad, o cierra con agendar_cita si ya aceptó uno.',
      )
    }

    return lines
  } catch {
    return []
  }
}
