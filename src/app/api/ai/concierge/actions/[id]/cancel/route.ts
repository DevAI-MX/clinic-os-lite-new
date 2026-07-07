import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'

type Params = { params: Promise<{ id: string }> }

/**
 * POST /api/ai/concierge/actions/[id]/cancel  (agent+)
 *
 * Cancela una propuesta del Concierge. Misma transición atómica que el
 * confirm (solo desde 'proposed'), sin ejecutar nada.
 */
export async function POST(_request: Request, { params }: Params) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent')
    const { id } = await params

    const nowIso = new Date().toISOString()
    const { data: action, error } = await supabase
      .from('assistant_actions')
      .update({ status: 'cancelled', resolved_by: userId, resolved_at: nowIso })
      .eq('id', id)
      .eq('account_id', accountId)
      .eq('status', 'proposed')
      .select('id')
      .maybeSingle()
    if (error) {
      console.error('[concierge/cancel] transition error:', error)
      return NextResponse.json({ error: 'Could not cancel action' }, { status: 500 })
    }
    if (!action) {
      return NextResponse.json(
        { error: 'La propuesta ya fue resuelta o expiró.', code: 'action_conflict' },
        { status: 409 },
      )
    }

    return NextResponse.json({ status: 'cancelled' })
  } catch (err) {
    return toErrorResponse(err)
  }
}
