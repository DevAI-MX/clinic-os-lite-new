import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { clinicTimezone } from '@/lib/ai/agent'
import {
  executeConfirmedAction,
  type ConciergeWriteToolName,
} from '@/lib/ai/concierge'

type Params = { params: Promise<{ id: string }> }

/**
 * POST /api/ai/concierge/actions/[id]/confirm  (agent+)
 *
 * El gate humano del Concierge: transiciona la propuesta
 * proposed → executing de forma ATÓMICA (el UPDATE condicionado es el
 * candado — dos clics simultáneos solo ganan uno) y ejecuta la
 * mutación con el cliente RLS del usuario que confirmó. Persiste
 * executed|failed con el resultado/error.
 */
export async function POST(_request: Request, { params }: Params) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent')
    const { id } = await params

    const limit = checkRateLimit(`concierge-action:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const nowIso = new Date().toISOString()
    // Transición atómica: solo una confirmación gana; propuestas
    // expiradas o ya resueltas no devuelven fila → 409.
    const { data: action, error } = await supabase
      .from('assistant_actions')
      .update({ status: 'executing', resolved_by: userId, resolved_at: nowIso })
      .eq('id', id)
      .eq('account_id', accountId)
      .eq('status', 'proposed')
      .gt('expires_at', nowIso)
      .select('id, tool_name, input, summary')
      .maybeSingle()
    if (error) {
      console.error('[concierge/confirm] transition error:', error)
      return NextResponse.json({ error: 'Could not confirm action' }, { status: 500 })
    }
    if (!action) {
      return NextResponse.json(
        { error: 'La propuesta ya fue resuelta o expiró.', code: 'action_conflict' },
        { status: 409 },
      )
    }

    const input =
      action.input && typeof action.input === 'object'
        ? ((action.input as { args?: Record<string, unknown> }).args ?? {})
        : {}

    try {
      const result = await executeConfirmedAction({
        db: supabase,
        accountId,
        userId,
        timezone: clinicTimezone(),
        now: new Date(),
        toolName: action.tool_name as ConciergeWriteToolName,
        input,
      })

      await supabase
        .from('assistant_actions')
        .update({ status: 'executed', result })
        .eq('id', id)
        .eq('account_id', accountId)

      return NextResponse.json({ status: 'executed', result })
    } catch (execErr) {
      const message =
        execErr instanceof Error ? execErr.message : 'La acción falló al ejecutarse.'
      await supabase
        .from('assistant_actions')
        .update({ status: 'failed', error: message })
        .eq('id', id)
        .eq('account_id', accountId)

      return NextResponse.json({ status: 'failed', error: message }, { status: 422 })
    }
  } catch (err) {
    return toErrorResponse(err)
  }
}
