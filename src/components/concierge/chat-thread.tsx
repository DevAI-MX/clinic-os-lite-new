'use client';

import { useEffect, useRef } from 'react';
import { Loader2, Mic, Sparkles, Square, UserCircle2, Volume2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ActionCard } from './action-card';
import { BlockView } from './block-view';
import { AttachmentView } from './attachment-view';
import type { ConciergeAction, ConciergeMessage, PlanRef } from './use-concierge-chat';

// ============================================================
// Transcript del Concierge. Usuario en burbuja (mismo lenguaje que el
// inbox); asistente SIN burbuja pesada — texto plano con avatar, como
// los chats LLM modernos — para que las action cards y los widgets
// (agenda, navegación) respiren. Auto-scroll pegado al fondo solo si
// el usuario ya estaba al fondo.
// ============================================================

interface ChatThreadProps {
  messages: ConciergeMessage[];
  actions: Record<string, ConciergeAction>;
  sending: boolean;
  statusLabel: string | null;
  loadingHistory: boolean;
  userName: string | null;
  playingId: string | null;
  onSuggestion: (text: string) => void;
  onConfirmAction: (id: string) => void;
  onCancelAction: (id: string) => void;
  /** "Confirmar plan" del PlanBlock: confirma las propuestas en orden.
   *  `plan` identifica el lote (sesión + mensaje) para que el server
   *  valide que cada acción pertenece a ese plan. */
  onConfirmBatch: (actionIds: string[], plan: PlanRef) => void;
  onPlayToggle: (id: string, text: string) => void;
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
  playingId,
  onSuggestion,
  onConfirmAction,
  onCancelAction,
  onConfirmBatch,
  onPlayToggle,
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
            confirmación. También puedes dictarme con el micrófono o adjuntar
            una imagen.
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
              <div className="flex max-w-[80%] flex-col items-end gap-1.5">
                {m.attachments.map((a) => (
                  <AttachmentView key={a.url} attachment={a} />
                ))}
                {m.content && (
                  <div className="rounded-2xl rounded-br-sm bg-primary px-3.5 py-2 text-sm text-primary-foreground">
                    <p className="whitespace-pre-wrap">{m.content}</p>
                  </div>
                )}
                {m.viaVoz && (
                  <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                    <Mic className="h-3 w-3" /> dictado por voz
                  </span>
                )}
              </div>
              <UserCircle2 className="mt-1 h-5 w-5 shrink-0 text-muted-foreground" />
            </div>
          ) : (
            <div key={m.id} className="flex gap-3">
              <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Sparkles className="h-3.5 w-3.5" />
              </div>
              <div className="group flex min-w-0 flex-1 flex-col gap-3">
                {m.blocks.map((block, i) => (
                  <BlockView
                    key={`${m.id}-b${i}`}
                    block={block}
                    actions={actions}
                    // El plan solo se puede confirmar cuando el mensaje ya
                    // está persistido (dbId real): confirm-batch valida el
                    // lote contra esa sesión + mensaje. Sin ids el botón
                    // queda deshabilitado (las tarjetas individuales siguen
                    // funcionando).
                    onConfirmPlan={
                      m.dbId && m.sessionId
                        ? (ids) =>
                            onConfirmBatch(ids, {
                              sessionId: m.sessionId!,
                              messageId: m.dbId!,
                            })
                        : undefined
                    }
                  />
                ))}
                {m.content && (
                  <div>
                    <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">
                      {m.content}
                    </p>
                    <button
                      type="button"
                      onClick={() => onPlayToggle(m.id, m.content)}
                      className={cn(
                        'mt-1.5 flex items-center gap-1 rounded text-[11px] text-muted-foreground transition-opacity hover:text-foreground',
                        playingId === m.id
                          ? 'opacity-100'
                          : 'opacity-0 focus-visible:opacity-100 group-hover:opacity-100',
                      )}
                      aria-label={playingId === m.id ? 'Detener voz' : 'Escuchar respuesta'}
                    >
                      {playingId === m.id ? (
                        <>
                          <Square className="h-3 w-3" /> Detener
                        </>
                      ) : (
                        <>
                          <Volume2 className="h-3 w-3" /> Escuchar
                        </>
                      )}
                    </button>
                  </div>
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
