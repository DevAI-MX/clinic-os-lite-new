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
