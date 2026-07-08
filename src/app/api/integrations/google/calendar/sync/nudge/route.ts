import { NextResponse } from 'next/server'

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { runDueCalendarSyncJobs } from '@/lib/integrations/google/sync-runner'

/**
 * POST /api/integrations/google/calendar/sync/nudge
 *
 * Disparo INMEDIATO y con sesión del drenado de la cola de calendario,
 * acotado a la cuenta del usuario. Lo llama el panel (fire-and-forget)
 * justo después de crear/editar/cancelar una cita, para que el evento
 * aparezca en el Google Calendar "Clínica" en ~1-2s en vez de esperar al
 * barrido periódico.
 *
 * A diferencia del cron (`/calendar/sync`), NO usa `x-cron-secret`: se
 * protege con la sesión (getCurrentAccount) y solo drena los jobs de esa
 * cuenta. Si algo falla, el barrido de respaldo (enganchado al cron de
 * automatizaciones) lo recupera igual — por eso el panel lo llama sin
 * esperar la respuesta.
 */
export async function POST() {
  try {
    const { accountId } = await getCurrentAccount()
    const result = await runDueCalendarSyncJobs(supabaseAdmin(), { accountId })
    return NextResponse.json(result)
  } catch (err) {
    return toErrorResponse(err)
  }
}
