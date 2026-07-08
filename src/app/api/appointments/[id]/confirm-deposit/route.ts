import { NextResponse, after } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import {
  confirmAppointmentDeposit,
  ConfirmDepositError,
} from '@/lib/clinic/confirm-deposit'
import { runDueCalendarSyncJobs } from '@/lib/integrations/google/sync-runner'

type Params = { params: Promise<{ id: string }> }

/**
 * POST /api/appointments/[id]/confirm-deposit  (agent+)
 *
 * El gate humano del anticipo: el equipo valida el comprobante y con
 * un clic el pago pasa a 'confirmado', la cita a 'confirmada', el
 * paciente recibe su confirmación por WhatsApp, queda la notificación
 * interna y el deal del Embudo IA avanza. Lo llaman el CRM (pestaña
 * Citas del contacto), el inbox (tarjeta y menú del hilo) y la hoja de
 * cita del calendario.
 *
 * Body opcional: { notify_patient?: boolean } — false confirma sin
 * mandar el WhatsApp (p. ej. pago en efectivo en recepción).
 *
 * La sincronización a Google Calendar la encola el trigger de BD con
 * el cambio de status; aquí solo drenamos la cola en `after()` para
 * que el evento pase de tentative a confirmed en segundos (mismo
 * patrón que el nudge del panel).
 */
export async function POST(request: Request, { params }: Params) {
  try {
    const { accountId, userId } = await requireRole('agent')
    const { id } = await params

    const limit = checkRateLimit(`confirm-deposit:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    // Body opcional y tolerante: sin body (o body inválido) = defaults.
    let notifyPatient: boolean | undefined
    try {
      const body = await request.json()
      if (body && typeof body.notify_patient === 'boolean') {
        notifyPatient = body.notify_patient
      }
    } catch {
      // sin body — se usa el default (avisar al paciente)
    }

    const result = await confirmAppointmentDeposit(supabaseAdmin(), {
      accountId,
      appointmentId: id,
      userId,
      notifyPatient,
    })

    after(() =>
      runDueCalendarSyncJobs(supabaseAdmin(), { accountId }).catch(() => {}),
    )

    return NextResponse.json(result)
  } catch (err) {
    if (err instanceof ConfirmDepositError) {
      return NextResponse.json({ error: err.message }, { status: err.status })
    }
    return toErrorResponse(err)
  }
}
