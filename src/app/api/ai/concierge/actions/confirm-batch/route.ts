import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { clinicTimezone } from '@/lib/ai/agent'
import { confirmActionsBatch } from '@/lib/ai/concierge'

// Tope de pasos por plan (un turno del Concierge no propone más que
// esto; también corta payloads maliciosos).
const MAX_BATCH_ACTIONS = 20

/**
 * POST /api/ai/concierge/actions/confirm-batch  (agent+)
 *
 * El "Confirmar plan" del PlanBlock: recibe los action_ids del plan
 * MÁS su identidad (session_id + message_id — el mensaje del asistente
 * que lo propuso hace de plan_id) y las ejecuta UNA POR UNA en orden,
 * reutilizando exactamente el mismo gate humano del confirm individual
 * (transición atómica proposed → executing + executeConfirmedAction
 * con el cliente RLS del usuario). Antes de ejecutar se valida que
 * cada action_id pertenezca a esa cuenta/sesión/mensaje: un id ajeno
 * vuelve como 'conflict' en su paso y NO se ejecuta. Un paso fallido
 * no detiene los siguientes. Responde el resumen por paso.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent')

    const limit = checkRateLimit(`concierge-action:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    const raw = body?.action_ids
    const actionIds =
      Array.isArray(raw) && raw.every((id) => typeof id === 'string' && id)
        ? ([...new Set(raw as string[])] as string[])
        : null
    if (!actionIds || actionIds.length === 0) {
      return NextResponse.json({ error: 'action_ids is required' }, { status: 400 })
    }
    if (actionIds.length > MAX_BATCH_ACTIONS) {
      return NextResponse.json(
        { error: `Máximo ${MAX_BATCH_ACTIONS} acciones por plan.` },
        { status: 400 },
      )
    }
    const sessionId =
      typeof body?.session_id === 'string' && body.session_id ? body.session_id : null
    const messageId =
      typeof body?.message_id === 'string' && body.message_id ? body.message_id : null
    if (!sessionId || !messageId) {
      return NextResponse.json(
        { error: 'session_id and message_id are required' },
        { status: 400 },
      )
    }

    const results = await confirmActionsBatch({
      db: supabase,
      accountId,
      userId,
      timezone: clinicTimezone(),
      now: new Date(),
      actionIds,
      sessionId,
      messageId,
    })

    return NextResponse.json({
      results,
      total: results.length,
      executed: results.filter((r) => r.status === 'executed').length,
      failed: results.filter((r) => r.status !== 'executed').length,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
