'use client';

import { useCallback, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase/client';

// ============================================================
// Estado del chat del Concierge: hidrata el historial desde Supabase
// (RLS) y consume el stream NDJSON de /api/ai/concierge/chat evento
// por evento. Las action cards viven en un mapa aparte (por id) para
// que confirmar/cancelar actualice una sola entrada sin re-mapear el
// transcript.
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

export interface ConciergeMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  actionIds: string[];
}

interface StreamEvent {
  type: 'session' | 'status' | 'action_proposal' | 'text' | 'done' | 'error';
  sessionId?: string;
  label?: string;
  action?: {
    id: string;
    toolName: string;
    summary: string;
    details: Record<string, string>;
    status: 'proposed';
    expiresAt: string;
  };
  text?: string;
  message?: string;
}

let tempCounter = 0;
const tempId = () => `tmp-${++tempCounter}`;

export function useConciergeChat() {
  const supabase = createClient();
  const [messages, setMessages] = useState<ConciergeMessage[]>([]);
  const [actions, setActions] = useState<Record<string, ConciergeAction>>({});
  const [sending, setSending] = useState(false);
  const [statusLabel, setStatusLabel] = useState<string | null>(null);
  const [loadingHistory, setLoadingHistory] = useState(false);
  // Evita que una hidratación vieja pise una más nueva si el usuario
  // cambia de sesión rápido.
  const loadSeq = useRef(0);

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
          (msgRes.data ?? []).map((m) => ({
            id: m.id as string,
            role: m.role as 'user' | 'assistant',
            content: (m.content as string) ?? '',
            actionIds: actionsByMessage[m.id as string] ?? [],
          })),
        );
        setActions(actionMap);
      } finally {
        if (seq === loadSeq.current) setLoadingHistory(false);
      }
    },
    [supabase],
  );

  /**
   * Manda un turno. Devuelve el sessionId (nuevo si no había) o null si
   * el turno falló antes de crear sesión.
   */
  const send = useCallback(
    async (
      sessionId: string | null,
      text: string,
    ): Promise<{ sessionId: string | null; error: string | null }> => {
      setSending(true);
      setStatusLabel(null);

      const userMsg: ConciergeMessage = {
        id: tempId(),
        role: 'user',
        content: text,
        actionIds: [],
      };
      const assistantMsgId = tempId();
      setMessages((prev) => [...prev, userMsg]);

      let resolvedSessionId: string | null = sessionId;
      let turnError: string | null = null;

      try {
        const res = await fetch('/api/ai/concierge/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId, message: text }),
        });

        if (!res.ok || !res.body) {
          const data = await res.json().catch(() => ({}));
          turnError =
            data.code === 'ai_not_configured'
              ? 'ai_not_configured'
              : (data.error ?? 'No pude contactar al Concierge.');
          setMessages((prev) => prev.filter((m) => m.id !== userMsg.id));
          return { sessionId: resolvedSessionId, error: turnError };
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let assistantInserted = false;

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
              setMessages((prev) => {
                if (!assistantInserted) {
                  assistantInserted = true;
                  return [
                    ...prev,
                    { id: assistantMsgId, role: 'assistant', content: '', actionIds: [a.id] },
                  ];
                }
                return prev.map((m) =>
                  m.id === assistantMsgId
                    ? { ...m, actionIds: [...m.actionIds, a.id] }
                    : m,
                );
              });
              break;
            }
            case 'text': {
              const content = event.text ?? '';
              setStatusLabel(null);
              setMessages((prev) => {
                if (!assistantInserted) {
                  assistantInserted = true;
                  return [
                    ...prev,
                    { id: assistantMsgId, role: 'assistant', content, actionIds: [] },
                  ];
                }
                return prev.map((m) =>
                  m.id === assistantMsgId ? { ...m, content } : m,
                );
              });
              break;
            }
            case 'error':
              turnError = event.message ?? 'El turno falló.';
              break;
            case 'done':
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
          return { sessionId: resolvedSessionId, error: turnError };
        }
        return { sessionId: resolvedSessionId, error: null };
      } catch {
        setMessages((prev) => prev.filter((m) => m.id !== userMsg.id));
        return { sessionId: resolvedSessionId, error: 'No pude contactar al Concierge.' };
      } finally {
        setSending(false);
        setStatusLabel(null);
      }
    },
    [],
  );

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
  };
}
