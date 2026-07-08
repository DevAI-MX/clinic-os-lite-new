'use client';

import { useCallback, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import type { ConciergeBlock } from '@/lib/ai/concierge/blocks';

// ============================================================
// Estado del chat del Concierge: hidrata el historial desde Supabase
// (RLS) y consume el stream NDJSON de /api/ai/concierge/chat evento
// por evento. Las action cards viven en un mapa aparte (por id) para
// que confirmar/cancelar actualice una sola entrada sin re-mapear el
// transcript. Los bloques (widget de agenda, chips de navegación) y
// los adjuntos viajan en content_json y se re-pintan igual desde el
// historial; la navegación solo se DISPARA con el evento en vivo.
// ============================================================

export type ConciergeActionStatus =
  | 'proposed'
  | 'executing'
  | 'executed'
  | 'failed'
  | 'cancelled'
  | 'expired';

export interface ConciergeAction {
  id: string;
  toolName: string;
  summary: string;
  details: Record<string, string>;
  status: ConciergeActionStatus;
  expiresAt: string;
  resultMessage?: string;
  error?: string;
}

/** Referencia a un archivo ya subido al bucket chat-media. */
export interface ConciergeAttachment {
  url: string;
  mime: string;
  name: string;
}

export interface ConciergeMessage {
  id: string;
  /** Id REAL de la fila en assistant_messages (null mientras el turno
   *  en vivo no se ha persistido). Es el "plan_id" que confirm-batch
   *  exige para validar que las acciones pertenecen a este plan. */
  dbId: string | null;
  /** Sesión a la que pertenece el mensaje (para confirm-batch). */
  sessionId: string | null;
  role: 'user' | 'assistant';
  content: string;
  actionIds: string[];
  blocks: ConciergeBlock[];
  attachments: ConciergeAttachment[];
  viaVoz: boolean;
}

/** Identidad del plan que confirm-batch valida server-side. */
export interface PlanRef {
  sessionId: string;
  messageId: string;
}

interface StreamEvent {
  type: 'session' | 'status' | 'action_proposal' | 'block' | 'text' | 'done' | 'error';
  sessionId?: string;
  messageId?: string | null;
  label?: string;
  action?: {
    id: string;
    toolName: string;
    summary: string;
    details: Record<string, string>;
    status: 'proposed';
    expiresAt: string;
  };
  block?: ConciergeBlock;
  text?: string;
  message?: string;
}

export interface SendExtra {
  attachments?: ConciergeAttachment[];
  via?: 'voz';
}

export interface SendResult {
  sessionId: string | null;
  error: string | null;
  /** Respuesta final del asistente (para TTS/auto-play). */
  reply: { id: string; text: string } | null;
  /** true si el turno navegó la vista en vivo (abrir_seccion) — la
   *  página activa la voz para que la respuesta se escuche. */
  navigated: boolean;
}

let tempCounter = 0;
const tempId = () => `tmp-${++tempCounter}`;

function emptyMessage(
  id: string,
  role: 'user' | 'assistant',
  content = '',
): ConciergeMessage {
  return {
    id,
    dbId: null,
    sessionId: null,
    role,
    content,
    actionIds: [],
    blocks: [],
    attachments: [],
    viaVoz: false,
  };
}

export function useConciergeChat(opts: { onNavigate?: (href: string) => void } = {}) {
  const supabase = createClient();
  const [messages, setMessages] = useState<ConciergeMessage[]>([]);
  const [actions, setActions] = useState<Record<string, ConciergeAction>>({});
  const [sending, setSending] = useState(false);
  const [statusLabel, setStatusLabel] = useState<string | null>(null);
  const [loadingHistory, setLoadingHistory] = useState(false);
  // Evita que una hidratación vieja pise una más nueva si el usuario
  // cambia de sesión rápido.
  const loadSeq = useRef(0);
  // Ref para no re-crear `send` cuando cambia el callback de navegación.
  const onNavigateRef = useRef(opts.onNavigate);
  onNavigateRef.current = opts.onNavigate;

  const reset = useCallback(() => {
    setMessages([]);
    setActions({});
    setStatusLabel(null);
  }, []);

  const loadSession = useCallback(
    async (sessionId: string) => {
      const seq = ++loadSeq.current;
      setLoadingHistory(true);
      try {
        const [msgRes, actRes] = await Promise.all([
          supabase
            .from('assistant_messages')
            .select('id, role, content, content_json')
            .eq('session_id', sessionId)
            .in('role', ['user', 'assistant'])
            .order('created_at', { ascending: true }),
          supabase
            .from('assistant_actions')
            .select('id, message_id, tool_name, input, summary, status, result, error, expires_at')
            .eq('session_id', sessionId)
            .order('proposed_at', { ascending: true }),
        ]);
        if (seq !== loadSeq.current) return;

        const actionMap: Record<string, ConciergeAction> = {};
        const actionsByMessage: Record<string, string[]> = {};
        for (const row of actRes.data ?? []) {
          const input = (row.input ?? {}) as { display?: Record<string, string> };
          const expired =
            row.status === 'proposed' &&
            new Date(row.expires_at as string).getTime() < Date.now();
          actionMap[row.id as string] = {
            id: row.id as string,
            toolName: row.tool_name as string,
            summary: row.summary as string,
            details: input.display ?? {},
            status: expired ? 'expired' : (row.status as ConciergeActionStatus),
            expiresAt: row.expires_at as string,
            resultMessage:
              (row.result as { mensaje?: string } | null)?.mensaje ?? undefined,
            error: (row.error as string | null) ?? undefined,
          };
          if (row.message_id) {
            const key = row.message_id as string;
            actionsByMessage[key] = [...(actionsByMessage[key] ?? []), row.id as string];
          }
        }

        setMessages(
          (msgRes.data ?? []).map((m) => {
            const json = (m.content_json ?? {}) as {
              blocks?: ConciergeBlock[];
              attachments?: ConciergeAttachment[];
              via_voz?: boolean;
            };
            return {
              id: m.id as string,
              dbId: m.id as string,
              sessionId,
              role: m.role as 'user' | 'assistant',
              content: (m.content as string) ?? '',
              actionIds: actionsByMessage[m.id as string] ?? [],
              blocks: Array.isArray(json.blocks) ? json.blocks : [],
              attachments: Array.isArray(json.attachments) ? json.attachments : [],
              viaVoz: json.via_voz === true,
            };
          }),
        );
        setActions(actionMap);
      } finally {
        if (seq === loadSeq.current) setLoadingHistory(false);
      }
    },
    [supabase],
  );

  /**
   * Manda un turno. Devuelve el sessionId (nuevo si no había), el error
   * del turno y la respuesta final del asistente (para auto-TTS).
   */
  const send = useCallback(
    async (
      sessionId: string | null,
      text: string,
      extra: SendExtra = {},
    ): Promise<SendResult> => {
      setSending(true);
      setStatusLabel(null);

      const attachments = extra.attachments ?? [];
      const userMsg: ConciergeMessage = {
        ...emptyMessage(tempId(), 'user', text),
        attachments,
        viaVoz: extra.via === 'voz',
      };
      const assistantMsgId = tempId();
      setMessages((prev) => [...prev, userMsg]);

      let resolvedSessionId: string | null = sessionId;
      let turnError: string | null = null;
      let replyText = '';
      let navigated = false;

      try {
        const res = await fetch('/api/ai/concierge/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionId,
            message: text,
            ...(attachments.length > 0 ? { attachments } : {}),
            ...(extra.via ? { via: extra.via } : {}),
          }),
        });

        if (!res.ok || !res.body) {
          const data = await res.json().catch(() => ({}));
          turnError =
            data.code === 'ai_not_configured'
              ? 'ai_not_configured'
              : (data.error ?? 'No pude contactar al Concierge.');
          setMessages((prev) => prev.filter((m) => m.id !== userMsg.id));
          return { sessionId: resolvedSessionId, error: turnError, reply: null, navigated };
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let assistantInserted = false;

        // Inserta el mensaje del asistente en el primer evento que lo
        // necesite y aplícale `mutate` (todas las rutas comparten esto).
        const upsertAssistant = (mutate: (m: ConciergeMessage) => ConciergeMessage) => {
          setMessages((prev) => {
            if (!assistantInserted) {
              assistantInserted = true;
              return [...prev, mutate(emptyMessage(assistantMsgId, 'assistant'))];
            }
            return prev.map((m) => (m.id === assistantMsgId ? mutate(m) : m));
          });
        };

        const handleEvent = (event: StreamEvent) => {
          switch (event.type) {
            case 'session':
              resolvedSessionId = event.sessionId ?? resolvedSessionId;
              break;
            case 'status':
              setStatusLabel(event.label ?? null);
              break;
            case 'action_proposal': {
              const a = event.action;
              if (!a) break;
              setActions((prev) => ({
                ...prev,
                [a.id]: {
                  id: a.id,
                  toolName: a.toolName,
                  summary: a.summary,
                  details: a.details ?? {},
                  status: 'proposed',
                  expiresAt: a.expiresAt,
                },
              }));
              upsertAssistant((m) => ({ ...m, actionIds: [...m.actionIds, a.id] }));
              break;
            }
            case 'block': {
              const block = event.block;
              if (!block) break;
              upsertAssistant((m) => ({ ...m, blocks: [...m.blocks, block] }));
              // Navegación autónoma: solo el evento EN VIVO mueve la
              // vista (el historial re-pinta el chip sin navegar).
              if (block.kind === 'navegacion') {
                navigated = true;
                onNavigateRef.current?.(block.href);
              }
              break;
            }
            case 'text': {
              const content = event.text ?? '';
              replyText = content;
              setStatusLabel(null);
              upsertAssistant((m) => ({ ...m, content }));
              break;
            }
            case 'error':
              turnError = event.message ?? 'El turno falló.';
              break;
            case 'done':
              // El turno ya quedó persistido: el messageId real habilita
              // "Confirmar plan" (confirm-batch lo exige para validar el
              // lote). Hasta este momento el botón del plan va deshabilitado.
              if (event.messageId) {
                const dbId = event.messageId;
                const sessionId = resolvedSessionId;
                upsertAssistant((m) => ({ ...m, dbId, sessionId }));
              }
              break;
          }
        };

        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let newline = buffer.indexOf('\n');
          while (newline >= 0) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (line) {
              try {
                handleEvent(JSON.parse(line) as StreamEvent);
              } catch {
                // línea malformada — se ignora
              }
            }
            newline = buffer.indexOf('\n');
          }
        }

        if (turnError) {
          // El turno del usuario SÍ quedó persistido server-side; solo
          // avisamos del fallo sin borrar nada.
          return { sessionId: resolvedSessionId, error: turnError, reply: null, navigated };
        }
        return {
          sessionId: resolvedSessionId,
          error: null,
          reply: replyText ? { id: assistantMsgId, text: replyText } : null,
          navigated,
        };
      } catch {
        setMessages((prev) => prev.filter((m) => m.id !== userMsg.id));
        return {
          sessionId: resolvedSessionId,
          error: 'No pude contactar al Concierge.',
          reply: null,
          navigated,
        };
      } finally {
        setSending(false);
        setStatusLabel(null);
      }
    },
    [],
  );

  /**
   * "Confirmar plan": ejecuta en orden todas las propuestas del plan
   * vía confirm-batch (server-side reusa el mismo gate atómico que el
   * confirm individual y valida que cada acción pertenezca al plan —
   * misma cuenta, sesión y mensaje). Un paso fallido no frena los
   * siguientes; cada tarjeta se actualiza con su resultado.
   */
  const confirmBatch = useCallback(async (actionIds: string[], plan: PlanRef) => {
    if (actionIds.length === 0) return;
    setActions((prev) => {
      const next = { ...prev };
      for (const id of actionIds) {
        if (next[id]) next[id] = { ...next[id], status: 'executing' };
      }
      return next;
    });
    const failAll = (message: string) =>
      setActions((prev) => {
        const next = { ...prev };
        for (const id of actionIds) {
          if (next[id] && next[id].status === 'executing') {
            next[id] = { ...next[id], status: 'failed', error: message };
          }
        }
        return next;
      });
    try {
      const res = await fetch('/api/ai/concierge/actions/confirm-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action_ids: actionIds,
          session_id: plan.sessionId,
          message_id: plan.messageId,
        }),
      });
      const data = await res.json().catch(() => ({}));
      const results = Array.isArray(data.results)
        ? (data.results as {
            action_id: string;
            status: string;
            result?: { mensaje?: string };
            error?: string;
          }[])
        : null;
      if (!res.ok || !results) {
        failAll(data.error ?? 'No pude ejecutar el plan.');
        return;
      }
      setActions((prev) => {
        const next = { ...prev };
        for (const r of results) {
          const current = next[r.action_id];
          if (!current) continue;
          if (r.status === 'executed') {
            next[r.action_id] = {
              ...current,
              status: 'executed',
              resultMessage: r.result?.mensaje ?? undefined,
            };
          } else if (r.status === 'conflict') {
            next[r.action_id] = { ...current, status: 'expired' };
          } else {
            next[r.action_id] = {
              ...current,
              status: 'failed',
              error: r.error ?? 'La acción falló al ejecutarse.',
            };
          }
        }
        return next;
      });
    } catch {
      failAll('No pude contactar al servidor.');
    }
  }, []);

  const resolveAction = useCallback(
    async (actionId: string, verb: 'confirm' | 'cancel') => {
      setActions((prev) => ({
        ...prev,
        [actionId]: { ...prev[actionId], status: 'executing' },
      }));
      try {
        const res = await fetch(`/api/ai/concierge/actions/${actionId}/${verb}`, {
          method: 'POST',
        });
        const data = await res.json().catch(() => ({}));
        setActions((prev) => {
          const current = prev[actionId];
          if (!current) return prev;
          if (res.ok && data.status === 'executed') {
            return {
              ...prev,
              [actionId]: {
                ...current,
                status: 'executed',
                resultMessage:
                  (data.result as { mensaje?: string } | null)?.mensaje ?? undefined,
              },
            };
          }
          if (res.ok && data.status === 'cancelled') {
            return { ...prev, [actionId]: { ...current, status: 'cancelled' } };
          }
          if (res.status === 409) {
            return { ...prev, [actionId]: { ...current, status: 'expired' } };
          }
          return {
            ...prev,
            [actionId]: {
              ...current,
              status: 'failed',
              error: data.error ?? 'La acción falló al ejecutarse.',
            },
          };
        });
      } catch {
        setActions((prev) => ({
          ...prev,
          [actionId]: {
            ...prev[actionId],
            status: 'failed',
            error: 'No pude contactar al servidor.',
          },
        }));
      }
    },
    [],
  );

  return {
    messages,
    actions,
    sending,
    statusLabel,
    loadingHistory,
    reset,
    loadSession,
    send,
    confirmAction: (id: string) => resolveAction(id, 'confirm'),
    cancelAction: (id: string) => resolveAction(id, 'cancel'),
    confirmBatch,
  };
}
