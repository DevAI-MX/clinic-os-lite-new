import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { loadAiConfig } from '@/lib/ai/config'
import { runClinicalAgent, clinicTimezone } from '@/lib/ai/agent'
import {
  CONCIERGE_TOOLS,
  createConciergeExecutor,
  buildConciergeSystemPrompt,
  type ProposedAction,
} from '@/lib/ai/concierge'
import { AiError, type ChatMessage } from '@/lib/ai/types'

// El loop puede encadenar varias rondas de tools + proveedor.
export const maxDuration = 60

// Mismo tope de transcript que el asistente interno / playground.
const MAX_TURNS = 20

/**
 * POST /api/ai/concierge/chat  (agent+)
 *
 * Un turno del Concierge. A diferencia del asistente interno
 * (stateless), aquí el cliente manda solo { sessionId?, message }: el
 * historial vive en assistant_messages y se trunca server-side.
 *
 * Responde application/x-ndjson — una línea JSON por evento:
 *   {type:'session', sessionId}          la sesión (nueva o existente)
 *   {type:'status', label}               actividad de tools en curso
 *   {type:'action_proposal', action}     tarjeta de confirmación nueva
 *   {type:'text', text}                  respuesta final del asistente
 *   {type:'done', messageId}             turno persistido
 *   {type:'error', message}              fallo del turno
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent')

    const limit = checkRateLimit(`concierge:${userId}`, RATE_LIMITS.aiDraft)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    const message = typeof body?.message === 'string' ? body.message.trim() : ''
    const sessionIdIn =
      typeof body?.sessionId === 'string' && body.sessionId ? body.sessionId : null
    if (!message) {
      return NextResponse.json({ error: 'message is required' }, { status: 400 })
    }

    const config = await loadAiConfig(supabase, accountId, {
      requireActive: false,
    }).catch((err) => {
      console.error('[ai/concierge] loadAiConfig error:', err)
      throw new AiError('Stored API key could not be decrypted.', {
        code: 'key_decrypt_failed',
        status: 400,
      })
    })
    if (!config) {
      return NextResponse.json(
        {
          error: 'No agent configured yet. Add your provider key in Setup.',
          code: 'ai_not_configured',
        },
        { status: 400 },
      )
    }

    // --- Sesión: reusar la existente (verificando tenencia) o crearla.
    let sessionId = sessionIdIn
    if (sessionId) {
      const { data: existing } = await supabase
        .from('assistant_sessions')
        .select('id')
        .eq('account_id', accountId)
        .eq('id', sessionId)
        .maybeSingle()
      if (!existing) {
        return NextResponse.json({ error: 'Session not found' }, { status: 404 })
      }
    } else {
      const title = message.length > 48 ? `${message.slice(0, 48)}…` : message
      const { data: created, error } = await supabase
        .from('assistant_sessions')
        .insert({ account_id: accountId, user_id: userId, title })
        .select('id')
        .single()
      if (error || !created) {
        console.error('[ai/concierge] session insert error:', error)
        return NextResponse.json({ error: 'Could not create session' }, { status: 500 })
      }
      sessionId = created.id as string
    }

    // --- Persistir el turno del usuario ANTES de llamar al modelo: un
    // fallo del proveedor no debe perder lo que el usuario escribió.
    const { error: userMsgErr } = await supabase.from('assistant_messages').insert({
      session_id: sessionId,
      account_id: accountId,
      role: 'user',
      content: message,
    })
    if (userMsgErr) {
      console.error('[ai/concierge] user message insert error:', userMsgErr)
      return NextResponse.json({ error: 'Could not persist message' }, { status: 500 })
    }

    // --- Historial server-side (incluye el turno recién insertado).
    const { data: historyRows } = await supabase
      .from('assistant_messages')
      .select('role, content')
      .eq('session_id', sessionId)
      .in('role', ['user', 'assistant'])
      .order('created_at', { ascending: true })

    const messages: ChatMessage[] = (historyRows ?? [])
      .filter(
        (m): m is { role: 'user' | 'assistant'; content: string } =>
          (m.role === 'user' || m.role === 'assistant') &&
          typeof m.content === 'string' &&
          m.content.trim().length > 0,
      )
      .slice(-MAX_TURNS)

    const timezone = clinicTimezone()
    const now = new Date()
    const encoder = new TextEncoder()
    const finalSessionId = sessionId

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const emit = (event: Record<string, unknown>) => {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`))
        }
        emit({ type: 'session', sessionId: finalSessionId })

        const proposals: ProposedAction[] = []
        try {
          const executeTool = createConciergeExecutor({
            sessionId: finalSessionId,
            events: {
              onStatus: (label) => emit({ type: 'status', label }),
              onProposal: (action) => {
                proposals.push(action)
                emit({ type: 'action_proposal', action })
              },
            },
          })

          const { text } = await runClinicalAgent({
            provider: config.provider,
            apiKey: config.apiKey,
            model: config.model,
            systemPrompt: buildConciergeSystemPrompt({ timezone, now }),
            messages,
            tools: CONCIERGE_TOOLS,
            executeTool,
            ctx: {
              // Todo corre bajo el cliente RLS del usuario logueado; las
              // tools filtran además por cuenta. No hay contacto fijo.
              db: supabase,
              accountId,
              contactId: '',
              conversationId: '',
              userId,
              contactName: null,
              timezone,
              now,
              embeddingsApiKey: config.embeddingsApiKey,
            },
          })

          // --- Persistir el turno del asistente + ligar propuestas.
          const contentJson =
            proposals.length > 0 ? { action_ids: proposals.map((p) => p.id) } : null
          const { data: assistantRow, error: aErr } = await supabase
            .from('assistant_messages')
            .insert({
              session_id: finalSessionId,
              account_id: accountId,
              role: 'assistant',
              content: text,
              content_json: contentJson,
            })
            .select('id')
            .single()
          if (aErr) console.error('[ai/concierge] assistant message insert error:', aErr)

          if (assistantRow && proposals.length > 0) {
            await supabase
              .from('assistant_actions')
              .update({ message_id: assistantRow.id })
              .in('id', proposals.map((p) => p.id))
              .eq('account_id', accountId)
          }

          await supabase
            .from('assistant_sessions')
            .update({ last_message_at: new Date().toISOString() })
            .eq('id', finalSessionId)
            .eq('account_id', accountId)

          emit({ type: 'text', text })
          emit({ type: 'done', messageId: assistantRow?.id ?? null })
        } catch (err) {
          console.error('[ai/concierge] turn error:', err)
          emit({
            type: 'error',
            message:
              err instanceof AiError
                ? err.message
                : 'No pude completar el turno. Intenta de nuevo.',
          })
        } finally {
          controller.close()
        }
      },
    })

    return new Response(stream, {
      headers: {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
      },
    })
  } catch (err) {
    if (err instanceof AiError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.status },
      )
    }
    return toErrorResponse(err)
  }
}
