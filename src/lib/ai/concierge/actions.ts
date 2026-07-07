// ============================================================
// clinicOS — ejecutor de acciones CONFIRMADAS del Concierge.
//
// El ÚNICO módulo del sistema que ejecuta las mutaciones propuestas
// por el Concierge, y solo lo invoca el endpoint de confirmación tras
// la transición atómica proposed → executing (el clic de "Confirmar"
// del humano). Corre con el cliente RLS del usuario que confirmó —
// jamás con service-role — y RE-VALIDA el estado contra la BD en el
// momento de ejecutar: el hueco pudo ocuparse o el pago resolverse
// entre la propuesta y la confirmación → error legible, nunca
// doble-book ni doble-confirmación.
//
// Las mutaciones son las MISMAS que el panel ya hace a mano
// (appointment-sheet, new-appointment-dialog, pipeline board), movidas
// a un ejecutor server-side.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { formatSlotLabel } from '../agent'
import { CONCIERGE_APPT_STATUSES, type ConciergeWriteToolName } from './tools'

// Estados de cita que ocupan un hueco (igual que el ejecutor clínico).
const ACTIVE_APPT_STATUSES = ['pendiente', 'confirmada', 'completada']

export interface ExecuteConfirmedActionArgs {
  /** Cliente RLS del usuario que CONFIRMÓ (nunca service-role). */
  db: SupabaseClient
  accountId: string
  userId: string
  timezone: string
  now: Date
  toolName: ConciergeWriteToolName
  /** El `input.args` validado que guardó la propuesta. */
  input: Record<string, unknown>
}

/** ¿El rango [start, end) choca con otra cita activa o un bloqueo? */
async function hasClash(
  db: SupabaseClient,
  accountId: string,
  start: Date,
  end: Date,
  excludeApptId?: string,
): Promise<boolean> {
  const startIso = start.toISOString()
  const endIso = end.toISOString()

  const apptQuery = db
    .from('appointments')
    .select('id')
    .eq('account_id', accountId)
    .in('status', ACTIVE_APPT_STATUSES)
    .lt('starts_at', endIso)
    .gt('ends_at', startIso)
    .limit(2)
  const { data: appts } = await apptQuery
  const clashingAppt = (appts ?? []).some((a) => a.id !== excludeApptId)
  if (clashingAppt) return true

  const { data: blocks } = await db
    .from('schedule_blocks')
    .select('id')
    .eq('account_id', accountId)
    .lt('starts_at', endIso)
    .gt('ends_at', startIso)
    .limit(1)
  return (blocks ?? []).length > 0
}

async function ejecutarAgendarCita(
  a: ExecuteConfirmedActionArgs,
): Promise<Record<string, unknown>> {
  const contactId = String(a.input.contact_id ?? '')
  const start = new Date(String(a.input.inicio ?? ''))
  if (!contactId || Number.isNaN(start.getTime())) {
    throw new Error('La propuesta quedó incompleta; vuelve a proponer la cita.')
  }
  if (start.getTime() <= a.now.getTime()) {
    throw new Error('Ese horario ya pasó. Propón la cita de nuevo con otra fecha.')
  }

  interface ProcedureRow {
    id: string
    duration_minutes: number
    deposit_amount: number | null
  }
  let procedure: ProcedureRow | null = null
  if (typeof a.input.procedure_id === 'string' && a.input.procedure_id) {
    const { data } = await a.db
      .from('procedures')
      .select('id, duration_minutes, deposit_amount')
      .eq('account_id', a.accountId)
      .eq('id', a.input.procedure_id)
      .maybeSingle()
    procedure = (data as ProcedureRow | null) ?? null
  }
  const duration = procedure?.duration_minutes ?? 60
  const end = new Date(start.getTime() + duration * 60 * 1000)

  if (await hasClash(a.db, a.accountId, start, end)) {
    throw new Error('Ese hueco ya no está libre. Pide otra disponibilidad y vuelve a proponer.')
  }

  // Mismo criterio que new-appointment-dialog: con anticipo requerido la
  // cita nace pendiente (de anticipo); sin anticipo, la confirmación del
  // doctor en la tarjeta ES la decisión humana → confirmada.
  const requiresDeposit = procedure?.deposit_amount != null
  const { data: row, error } = await a.db
    .from('appointments')
    .insert({
      account_id: a.accountId,
      contact_id: contactId,
      procedure_id: procedure?.id ?? null,
      appointment_type:
        typeof a.input.tipo === 'string' && a.input.tipo ? a.input.tipo : 'valoracion',
      status: requiresDeposit ? 'pendiente' : 'confirmada',
      deposit_status: requiresDeposit ? 'pendiente' : 'no_aplica',
      deposit_amount: requiresDeposit ? procedure!.deposit_amount : null,
      starts_at: start.toISOString(),
      ends_at: end.toISOString(),
      notes: typeof a.input.notas === 'string' && a.input.notas ? a.input.notas : null,
      created_by: a.userId,
    })
    .select('id')
    .single()
  if (error || !row) {
    throw new Error(`No pude crear la cita: ${error?.message ?? 'error desconocido'}`)
  }

  return {
    appointment_id: row.id,
    mensaje: `Cita creada para ${formatSlotLabel(start, a.timezone)}${
      requiresDeposit ? ' (pendiente de anticipo)' : ' (confirmada)'
    }.`,
  }
}

async function ejecutarReagendarCita(
  a: ExecuteConfirmedActionArgs,
): Promise<Record<string, unknown>> {
  const apptId = String(a.input.appointment_id ?? '')
  const start = new Date(String(a.input.inicio ?? ''))
  if (!apptId || Number.isNaN(start.getTime())) {
    throw new Error('La propuesta quedó incompleta; vuelve a proponer el reagendado.')
  }

  const { data: appt } = await a.db
    .from('appointments')
    .select('id, starts_at, ends_at, status')
    .eq('account_id', a.accountId)
    .eq('id', apptId)
    .maybeSingle()
  if (!appt) throw new Error('Esa cita ya no existe.')
  if (!['pendiente', 'confirmada'].includes(appt.status as string)) {
    throw new Error(`Esa cita ahora está "${appt.status}"; ya no se puede reagendar.`)
  }

  const durationMs =
    new Date(appt.ends_at as string).getTime() - new Date(appt.starts_at as string).getTime()
  const end = new Date(start.getTime() + Math.max(durationMs, 15 * 60 * 1000))

  if (await hasClash(a.db, a.accountId, start, end, apptId)) {
    throw new Error('Ese hueco ya no está libre. Pide otra disponibilidad y vuelve a proponer.')
  }

  const { error } = await a.db
    .from('appointments')
    .update({ starts_at: start.toISOString(), ends_at: end.toISOString() })
    .eq('id', apptId)
    .eq('account_id', a.accountId)
  if (error) throw new Error(`No pude reagendar la cita: ${error.message}`)

  return {
    appointment_id: apptId,
    mensaje: `Cita movida a ${formatSlotLabel(start, a.timezone)}.`,
  }
}

async function ejecutarActualizarEstadoCita(
  a: ExecuteConfirmedActionArgs,
): Promise<Record<string, unknown>> {
  const apptId = String(a.input.appointment_id ?? '')
  const estado = String(a.input.estado ?? '')
  if (!apptId || !CONCIERGE_APPT_STATUSES.includes(estado as never)) {
    throw new Error('La propuesta quedó incompleta; vuelve a proponer el cambio de estado.')
  }

  const { data: appt } = await a.db
    .from('appointments')
    .select('id, status')
    .eq('account_id', a.accountId)
    .eq('id', apptId)
    .maybeSingle()
  if (!appt) throw new Error('Esa cita ya no existe.')
  if (appt.status === estado) {
    return { appointment_id: apptId, mensaje: `La cita ya estaba "${estado}".` }
  }

  const { error } = await a.db
    .from('appointments')
    .update({ status: estado })
    .eq('id', apptId)
    .eq('account_id', a.accountId)
  if (error) throw new Error(`No pude actualizar la cita: ${error.message}`)

  return { appointment_id: apptId, mensaje: `Cita marcada como ${estado}.` }
}

async function ejecutarValidarAnticipo(
  a: ExecuteConfirmedActionArgs,
): Promise<Record<string, unknown>> {
  const paymentId = String(a.input.payment_id ?? '')
  if (!paymentId) {
    throw new Error('La propuesta quedó incompleta; vuelve a proponer la validación.')
  }

  // Transición atómica del pago: solo si sigue pendiente. Mismo flujo
  // que markDepositPaid() en appointment-sheet.tsx.
  const nowIso = a.now.toISOString()
  const { data: updated, error } = await a.db
    .from('payments')
    .update({ status: 'confirmado', confirmed_by: a.userId, confirmed_at: nowIso })
    .eq('id', paymentId)
    .eq('account_id', a.accountId)
    .eq('status', 'pendiente')
    .select('id, appointment_id, amount, currency')
    .maybeSingle()
  if (error) throw new Error(`No pude confirmar el pago: ${error.message}`)
  if (!updated) {
    throw new Error('Ese pago ya fue resuelto por alguien más (o ya no existe).')
  }

  if (updated.appointment_id) {
    const { data: appt } = await a.db
      .from('appointments')
      .select('id, status')
      .eq('account_id', a.accountId)
      .eq('id', updated.appointment_id as string)
      .maybeSingle()
    if (appt) {
      await a.db
        .from('appointments')
        .update({
          deposit_status: 'pagado',
          ...(appt.status === 'pendiente' ? { status: 'confirmada' } : {}),
        })
        .eq('id', appt.id)
        .eq('account_id', a.accountId)
    }
  }

  return {
    payment_id: paymentId,
    mensaje: 'Anticipo confirmado; la cita quedó con anticipo pagado.',
  }
}

async function ejecutarMoverDeal(
  a: ExecuteConfirmedActionArgs,
): Promise<Record<string, unknown>> {
  const dealId = String(a.input.deal_id ?? '')
  const stageId = String(a.input.stage_id ?? '')
  if (!dealId || !stageId) {
    throw new Error('La propuesta quedó incompleta; vuelve a proponer el movimiento.')
  }

  const { data: deal } = await a.db
    .from('deals')
    .select('id, pipeline_id')
    .eq('account_id', a.accountId)
    .eq('id', dealId)
    .maybeSingle()
  if (!deal) throw new Error('Ese deal ya no existe.')

  const { data: stage } = await a.db
    .from('pipeline_stages')
    .select('id, name, pipeline_id')
    .eq('id', stageId)
    .maybeSingle()
  if (!stage || stage.pipeline_id !== deal.pipeline_id) {
    throw new Error('Esa etapa ya no pertenece al pipeline del deal.')
  }

  const { error } = await a.db
    .from('deals')
    .update({ stage_id: stageId })
    .eq('id', dealId)
    .eq('account_id', a.accountId)
  if (error) throw new Error(`No pude mover el deal: ${error.message}`)

  return { deal_id: dealId, mensaje: `Lead movido a "${stage.name}".` }
}

async function ejecutarCrearNotaPaciente(
  a: ExecuteConfirmedActionArgs,
): Promise<Record<string, unknown>> {
  const contactId = String(a.input.contact_id ?? '')
  const dato = String(a.input.dato ?? '').trim()
  const categoria = String(a.input.categoria ?? 'nota')
  if (!contactId || !dato) {
    throw new Error('La propuesta quedó incompleta; vuelve a proponer la nota.')
  }

  const { error } = await a.db.from('patient_records').insert({
    account_id: a.accountId,
    contact_id: contactId,
    category: categoria,
    content: dato,
    source: 'equipo',
    is_active: true,
    created_by: a.userId,
  })
  if (error) throw new Error(`No pude guardar la nota: ${error.message}`)

  return { contact_id: contactId, mensaje: 'Nota agregada al expediente.' }
}

/**
 * Ejecuta la mutación de una acción ya confirmada. Lanza Error con
 * mensaje legible ante cualquier fallo — el endpoint de confirmación lo
 * captura y persiste el estado 'failed' con ese texto.
 */
export async function executeConfirmedAction(
  args: ExecuteConfirmedActionArgs,
): Promise<Record<string, unknown>> {
  switch (args.toolName) {
    case 'agendar_cita':
      return ejecutarAgendarCita(args)
    case 'reagendar_cita':
      return ejecutarReagendarCita(args)
    case 'actualizar_estado_cita':
      return ejecutarActualizarEstadoCita(args)
    case 'validar_anticipo':
      return ejecutarValidarAnticipo(args)
    case 'mover_deal':
      return ejecutarMoverDeal(args)
    case 'crear_nota_paciente':
      return ejecutarCrearNotaPaciente(args)
    default:
      throw new Error(`Acción desconocida: ${args.toolName}`)
  }
}
