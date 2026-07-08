// ============================================================
// clinicOS — confirmación de pago de una cita, lado servidor.
//
// El cierre del ciclo del anticipo (incidente 2026-07-08): la IA
// prevalida el comprobante y lo deja "en revisión"; ANTES el equipo
// solo podía confirmarlo desde la hoja de cita del calendario, y si
// respondía por chat ("tu pago se realizó correctamente") la BD nunca
// se enteraba — la IA contradecía al equipo y el CRM/calendario/Google
// seguían diciendo "pendiente".
//
// `confirmAppointmentDeposit` es el ÚNICO camino de confirmación del
// panel (lo usan el botón "Confirmar pago" del CRM, la tarjeta del
// inbox, el menú del hilo y la hoja de cita del calendario, todos vía
// POST /api/appointments/[id]/confirm-deposit). En una llamada:
//
//   1. payments  → 'confirmado' (o crea el pago si la IA no prevalidó)
//   2. appointments → deposit_status='pagado', pendiente→'confirmada'
//      (el UPDATE condicionado es el claim: dos clics simultáneos solo
//      disparan UNA vez los efectos secundarios)
//   3. deal del "Embudo IA" → etapa "Agendado" (best-effort)
//   4. notificación interna `deposit_confirmed` (best-effort)
//   5. WhatsApp al paciente confirmando pago + cita (best-effort:
//      queda como mensaje del equipo, así la IA lo ve como [Equipo]:)
//
// El trigger de BD (migración 046) encola la sincronización a Google
// Calendar con el cambio de status; el caller (la API route) drena la
// cola en `after()` para que el evento pase a "confirmed" en segundos.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { clinicTimezone, formatSlotLabel } from '@/lib/ai/agent'
import { advanceFunnelDealOnDepositConfirmed } from '@/lib/ai/agent/execute'
import { sendMessageToConversation } from '@/lib/whatsapp/send-message'
import { CLINIC_CURRENCY } from '@/lib/clinic/types'

/** Error de dominio con status HTTP sugerido — la route lo mapea tal cual. */
export class ConfirmDepositError extends Error {
  readonly status: number
  constructor(message: string, status = 400) {
    super(message)
    this.name = 'ConfirmDepositError'
    this.status = status
  }
}

export interface ConfirmDepositArgs {
  /** Cuenta del usuario autenticado — TODA consulta se acota con ella. */
  accountId: string
  appointmentId: string
  /** Usuario del panel que confirma (confirmed_by / notificación). */
  userId: string
  /** false = confirmar sin avisar al paciente por WhatsApp. */
  notifyPatient?: boolean
}

export type WhatsappOutcome =
  | 'sent'
  | 'skipped' // notifyPatient=false o cita ya completada
  | 'no_conversation' // el contacto no tiene conversación donde escribirle
  | 'failed' // el envío falló (el resto de la confirmación ya quedó)

export interface ConfirmDepositResult {
  ok: true
  /** true = otro clic ya la había confirmado (no se repiten efectos). */
  alreadyConfirmed: boolean
  appointmentStatus: string
  whatsapp: WhatsappOutcome
}

interface AppointmentRow {
  id: string
  contact_id: string
  conversation_id: string | null
  status: string
  deposit_status: string
  deposit_amount: number | null
  starts_at: string
  procedure: { name: string; currency: string | null } | { name: string; currency: string | null }[] | null
}

function procedureOf(appt: AppointmentRow): { name: string; currency: string | null } | null {
  return Array.isArray(appt.procedure) ? (appt.procedure[0] ?? null) : appt.procedure
}

/**
 * Confirma el anticipo de una cita y dispara los avisos. `db` es el
 * cliente service-role (la route ya autenticó y pasa su accountId);
 * la tenencia se impone por código en cada query, igual que en el
 * ejecutor del agente.
 */
export async function confirmAppointmentDeposit(
  db: SupabaseClient,
  args: ConfirmDepositArgs,
): Promise<ConfirmDepositResult> {
  const { accountId, appointmentId, userId } = args
  const notifyPatient = args.notifyPatient !== false
  const nowIso = new Date().toISOString()

  const { data: appt, error: apptErr } = await db
    .from('appointments')
    .select(
      'id, contact_id, conversation_id, status, deposit_status, deposit_amount, starts_at, procedure:procedures(name, currency)',
    )
    .eq('account_id', accountId)
    .eq('id', appointmentId)
    .maybeSingle()
  if (apptErr) {
    throw new ConfirmDepositError(`No pude leer la cita: ${apptErr.message}`, 500)
  }
  if (!appt) throw new ConfirmDepositError('Esa cita no existe.', 404)

  const appointment = appt as unknown as AppointmentRow
  if (appointment.status === 'cancelada') {
    throw new ConfirmDepositError(
      'La cita está cancelada; no hay pago que confirmar.',
      409,
    )
  }
  if (appointment.deposit_status === 'no_aplica') {
    throw new ConfirmDepositError('Esta cita no requiere anticipo.', 409)
  }

  // --- 1) El pago: confirma el prevalidado por la IA o crea uno. ----
  // Va ANTES del claim de la cita: es idempotente (confirmar dos veces
  // deja los mismos valores) y así el pago nunca queda 'pendiente' con
  // la cita ya pagada.
  const procedure = procedureOf(appointment)
  const amount = Number(appointment.deposit_amount) || 0
  const { data: existingPayment, error: lookupErr } = await db
    .from('payments')
    .select('id, status')
    .eq('account_id', accountId)
    .eq('appointment_id', appointment.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (lookupErr) {
    throw new ConfirmDepositError(
      `No pude leer el pago de la cita: ${lookupErr.message}`,
      500,
    )
  }
  if (existingPayment) {
    if (existingPayment.status !== 'confirmado') {
      const { error } = await db
        .from('payments')
        .update({ status: 'confirmado', confirmed_by: userId, confirmed_at: nowIso })
        .eq('account_id', accountId)
        .eq('id', existingPayment.id)
      if (error) {
        throw new ConfirmDepositError(`No pude confirmar el pago: ${error.message}`, 500)
      }
    }
  } else if (amount > 0) {
    const { error } = await db.from('payments').insert({
      account_id: accountId,
      contact_id: appointment.contact_id,
      appointment_id: appointment.id,
      amount,
      currency: procedure?.currency || CLINIC_CURRENCY,
      method: 'transferencia',
      status: 'confirmado',
      concept: procedure ? `Anticipo · ${procedure.name}` : 'Anticipo de cita',
      confirmed_by: userId,
      confirmed_at: nowIso,
    })
    if (error) {
      throw new ConfirmDepositError(`No pude registrar el pago: ${error.message}`, 500)
    }
  }

  // --- 2) La cita — UPDATE condicionado como claim anti-doble-clic. --
  const wasPending = appointment.status === 'pendiente'
  const { data: claimed, error: claimErr } = await db
    .from('appointments')
    .update({
      deposit_status: 'pagado',
      // Solo sube pendiente → confirmada; no degrada completada.
      ...(wasPending ? { status: 'confirmada' } : {}),
    })
    .eq('account_id', accountId)
    .eq('id', appointment.id)
    .neq('deposit_status', 'pagado')
    .select('id, status')
  if (claimErr) {
    throw new ConfirmDepositError(
      `El pago quedó confirmado pero no pude actualizar la cita: ${claimErr.message}`,
      500,
    )
  }
  if (!claimed || claimed.length === 0) {
    // Alguien más ganó la carrera (o ya estaba pagada): los efectos
    // secundarios ya salieron (o saldrán) por ese camino.
    return {
      ok: true,
      alreadyConfirmed: true,
      appointmentStatus: appointment.status,
      whatsapp: 'skipped',
    }
  }
  const finalStatus = (claimed[0]?.status as string) ?? (wasPending ? 'confirmada' : appointment.status)

  // --- Datos del contacto para el aviso y el mensaje. ---------------
  const { data: contact } = await db
    .from('contacts')
    .select('name, phone')
    .eq('account_id', accountId)
    .eq('id', appointment.contact_id)
    .maybeSingle()
  const contactName = (contact?.name as string | null) ?? null
  const who = contactName || (contact?.phone as string | null) || 'El paciente'

  // --- 3) Embudo IA → "Agendado" (best-effort). ---------------------
  await advanceFunnelDealOnDepositConfirmed({
    db,
    accountId,
    contactId: appointment.contact_id,
    conversationId: appointment.conversation_id,
    userId,
    contactName,
  })

  // --- 4) Notificación interna (best-effort; requiere migración 048).
  try {
    const { error: notifErr } = await db.from('notifications').insert({
      account_id: accountId,
      user_id: userId,
      type: 'deposit_confirmed',
      conversation_id: appointment.conversation_id,
      contact_id: appointment.contact_id,
      actor_user_id: userId,
      title: 'Pago confirmado',
      body: `${who}: anticipo confirmado — la cita quedó confirmada y se le avisó por WhatsApp.`,
    })
    if (notifErr) {
      console.error('[confirm-deposit] notification insert failed:', notifErr)
    }
  } catch (err) {
    console.error('[confirm-deposit] notification insert failed:', err)
  }

  // --- 5) WhatsApp al paciente (best-effort). -----------------------
  let whatsapp: WhatsappOutcome = 'skipped'
  const shouldNotify = notifyPatient && appointment.status !== 'completada'
  if (shouldNotify) {
    const conversationId = await resolveConversationId(db, accountId, appointment)
    if (!conversationId) {
      whatsapp = 'no_conversation'
    } else {
      try {
        await sendMessageToConversation(db, accountId, {
          conversationId,
          messageType: 'text',
          contentText: buildConfirmationMessage({
            contactName,
            startsAt: appointment.starts_at,
            procedureName: procedure?.name ?? null,
          }),
        })
        whatsapp = 'sent'
      } catch (err) {
        // La confirmación en BD ya quedó; el mensaje se puede reenviar
        // a mano desde el inbox. Nunca revertimos por un fallo de envío.
        console.error('[confirm-deposit] whatsapp send failed:', err)
        whatsapp = 'failed'
      }
    }
  }

  return { ok: true, alreadyConfirmed: false, appointmentStatus: finalStatus, whatsapp }
}

/** Conversación donde avisarle al paciente: la de la cita o la más reciente. */
async function resolveConversationId(
  db: SupabaseClient,
  accountId: string,
  appointment: AppointmentRow,
): Promise<string | null> {
  if (appointment.conversation_id) return appointment.conversation_id
  const { data } = await db
    .from('conversations')
    .select('id')
    .eq('account_id', accountId)
    .eq('contact_id', appointment.contact_id)
    .order('last_message_at', { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle()
  return (data?.id as string | undefined) ?? null
}

/**
 * Mensaje de confirmación para el paciente. Determinista (sin modelo):
 * solo datos reales de la cita. Mismo estilo WhatsApp que Sofía
 * (es-MX, texto plano, signos solo de cierre). Se persiste como
 * mensaje del EQUIPO (sender_type='agent'), así que si la IA retoma el
 * hilo lo verá como "[Equipo]:" y no lo contradirá.
 */
export function buildConfirmationMessage(args: {
  contactName: string | null
  startsAt: string
  procedureName: string | null
}): string {
  const slot = formatSlotLabel(new Date(args.startsAt), clinicTimezone())
  const saludo = args.contactName ? `${args.contactName}, tu` : 'Tu'
  const servicio = args.procedureName ? ` de ${args.procedureName}` : ''
  return `${saludo} pago quedó confirmado ✅ Tu cita${servicio} quedó confirmada para ${slot}. Te esperamos! Si necesitas mover tu cita, escríbenos por aquí.`
}
