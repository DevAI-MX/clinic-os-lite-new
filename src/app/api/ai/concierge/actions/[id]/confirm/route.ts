import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { clinicTimezone } from '@/lib/ai/agent'
import { confirmProposedAction } from '@/lib/ai/concierge'

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
