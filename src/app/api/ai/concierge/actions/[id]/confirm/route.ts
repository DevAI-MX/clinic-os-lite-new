import { NextResponse, after } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { clinicTimezone } from '@/lib/ai/agent'
import { confirmProposedAction } from '@/lib/ai/concierge'
import { runDueCalendarSyncJobs } from '@/lib/integrations/google/sync-runner'

type Params = { params: Promise<{ id: string }> }

/**
 * POST /api/ai/concierge/actions/[id]/confirm  (agent+)
 *
 * El gate humano del Concierge: transiciona la propuesta
 * proposed → executing de forma ATÓMICA (el UPDATE condicionado es el
 * candado — dos clics simultáneos solo ganan uno) y ejecuta la
 * mutación con el cliente RLS del usuario que confirmó. Persiste
 * executed|failed con el resultado/error. La lógica vive en
 * confirmProposedAction (compartida con confirm-batch).
 *
 * Si la acción reagenda/cancela/agenda una cita, el trigger de BD
 * encola el job de Google Calendar; lo drenamos aquí en `after()` para
 * que el evento se mueva/borre en Google en segundos (mismo patrón que
 * el nudge del panel y confirm-deposit). Sin esto, el cambio solo
 * viajaría cuando corriera el cron de automatizaciones.
 */
export async function POST(_request: Request, { params }: Params) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent')
    const { id } = await params

    const limit = checkRateLimit(`concierge-action:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const outcome = await confirmProposedAction({
      db: supabase,
      accountId,
      userId,
      timezone: clinicTimezone(),
      now: new Date(),
      actionId: id,
    })

    if (outcome.status === 'executed') {
      after(() =>
        runDueCalendarSyncJobs(supabaseAdmin(), { accountId }).catch(() => {}),
      )
    }

    switch (outcome.status) {
      case 'executed':
        return NextResponse.json({ status: 'executed', result: outcome.result })
      case 'failed':
        return NextResponse.json(
          { status: 'failed', error: outcome.error },
          { status: 422 },
        )
      case 'conflict':
        return NextResponse.json(
          { error: 'La propuesta ya fue resuelta o expiró.', code: 'action_conflict' },
          { status: 409 },
        )
      default:
        return NextResponse.json({ error: 'Could not confirm action' }, { status: 500 })
    }
  } catch (err) {
    return toErrorResponse(err)
  }
}
