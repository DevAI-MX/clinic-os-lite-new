'use client';

import { useEffect, useRef } from 'react';
import { Loader2, Sparkles, UserCircle2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ActionCard } from './action-card';
import type { ConciergeAction, ConciergeMessage } from './use-concierge-chat';

// ============================================================
// Transcript del Concierge. Usuario en burbuja (mismo lenguaje que el
// inbox); asistente SIN burbuja pesada — texto plano con avatar, como
// los chats LLM modernos — para que las action cards respiren.
// Auto-scroll pegado al fondo solo si el usuario ya estaba al fondo.
// ============================================================

interface ChatThreadProps {
  messages: ConciergeMessage[];
  actions: Record<string, ConciergeAction>;
  sending: boolean;
  statusLabel: string | null;
  loadingHistory: boolean;
  userName: string | null;
  onSuggestion: (text: string) => void;
  onConfirmAction: (id: string) => void;
  onCancelAction: (id: string) => void;
}

const SUGGESTIONS = [
  '¿Cómo va el día?',
  '¿Qué anticipos faltan por revisar?',
  '¿Cómo va el embudo?',
  'Busca a un paciente…',
];

export function ChatThread({
  messages,
  actions,
  sending,
  statusLabel,
  loadingHistory,
  userName,
  onSuggestion,
  onConfirmAction,
  onCancelAction,
}: ChatThreadProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) {
      el.scrollTo({ top: el.scrollHeight });
    }
  }, [messages, actions, sending, statusLabel]);

  if (loadingHistory) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Cargando conversación…
      </div>
    );
  }

  if (messages.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          <Sparkles className="h-6 w-6" />
        </div>
        <div>
          <p className="text-base font-medium text-foreground">
            {userName ? `Hola, ${userName.split(' ')[0]}.` : 'Hola.'}
          </p>
          <p className="mt-1 max-w-sm text-sm text-muted-foreground">
            Consulta tu operación o pídeme acciones — nada se ejecuta sin tu
            confirmación.
          </p>
        </div>
        <div className="flex max-w-md flex-wrap justify-center gap-2">
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => onSuggestion(s)}
              className="rounded-full border border-border bg-card px-3 py-1.5 text-xs text-foreground transition-colors hover:border-primary/40 hover:bg-primary/5"
            >
              {s}
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      className="flex-1 overflow-y-auto"
    >
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 py-6">
        {messages.map((m) =>
          m.role === 'user' ? (
            <div key={m.id} className="flex justify-end gap-2">
              <div className="max-w-[80%] rounded-2xl rounded-br-sm bg-primary px-3.5 py-2 text-sm text-primary-foreground">
                <p className="whitespace-pre-wrap">{m.content}</p>
              </div>
              <UserCircle2 className="mt-1 h-5 w-5 shrink-0 text-muted-foreground" />
            </div>
          ) : (
            <div key={m.id} className="flex gap-3">
              <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Sparkles className="h-3.5 w-3.5" />
              </div>
              <div className="flex min-w-0 flex-1 flex-col gap-3">
                {m.content && (
                  <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">
                    {m.content}
                  </p>
                )}
                {m.actionIds.map((id) => {
                  const action = actions[id];
                  if (!action) return null;
                  return (
                    <ActionCard
                      key={id}
                      action={action}
                      onConfirm={onConfirmAction}
                      onCancel={onCancelAction}
                    />
                  );
                })}
              </div>
            </div>
          ),
        )}

        {sending && (
          <div className="flex items-center gap-3">
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Sparkles className="h-3.5 w-3.5" />
            </div>
            <div className={cn('flex items-center gap-2 text-sm text-muted-foreground')}>
              <Loader2 className="h-4 w-4 animate-spin" />
              {statusLabel ?? 'Pensando…'}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
