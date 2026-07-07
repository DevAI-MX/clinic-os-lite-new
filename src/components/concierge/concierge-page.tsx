'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { toast } from 'sonner';
import { Plus, Sparkles } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import { SessionList, type SessionSummary } from './session-list';
import { ChatThread } from './chat-thread';
import { Composer } from './composer';
import { useConciergeChat } from './use-concierge-chat';

// ============================================================
// Orquestador de /concierge: rail de sesiones (lg+) + chat. La sesión
// activa vive en la URL (?s=) para deep-links y refresh sin pérdida.
// El historial y las sesiones se leen con el cliente RLS del browser;
// los turnos y las confirmaciones van por las rutas API.
// ============================================================

export function ConciergePage() {
  const supabase = createClient();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { profile } = useAuth();

  const activeId = searchParams.get('s');
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [input, setInput] = useState('');
  const chat = useConciergeChat();
  // Extraídas del hook para poder listarlas como deps sin arrastrar el
  // objeto entero (su identidad cambia en cada render).
  const { loadSession, reset, send } = chat;

  // setSessions vive dentro del callback de la promesa (no síncrono en
  // el cuerpo del efecto) — mismo criterio que /pipelines.
  const refreshSessions = useCallback(
    () =>
      supabase
        .from('assistant_sessions')
        .select('id, title, last_message_at')
        .order('last_message_at', { ascending: false })
        .limit(100)
        .then(({ data }) => setSessions((data as SessionSummary[]) ?? [])),
    [supabase],
  );

  useEffect(() => {
    void refreshSessions();
  }, [refreshSessions]);

  useEffect(() => {
    if (activeId) void loadSession(activeId);
    else reset();
  }, [activeId, loadSession, reset]);

  const selectSession = (id: string | null) => {
    router.replace(id ? `/concierge?s=${id}` : '/concierge');
  };

  const handleSend = async (textOverride?: string) => {
    const text = (textOverride ?? input).trim();
    if (!text || chat.sending) return;
    setInput('');

    const { sessionId, error } = await send(activeId, text);

    if (error === 'ai_not_configured') {
      toast.error('Configura tu agente primero (proveedor y API key).', {
        action: { label: 'Ir a Setup', onClick: () => router.push('/agents') },
      });
      setInput(text);
      return;
    }
    if (error) {
      toast.error(error);
      return;
    }
    if (sessionId && sessionId !== activeId) {
      router.replace(`/concierge?s=${sessionId}`);
    }
    void refreshSessions();
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm('¿Eliminar esta conversación? Se borra también su historial.')) {
      return;
    }
    const { error } = await supabase.from('assistant_sessions').delete().eq('id', id);
    if (error) {
      toast.error('No pude eliminar la conversación.');
      return;
    }
    if (activeId === id) selectSession(null);
    void refreshSessions();
  };

  return (
    <div className="-m-4 flex h-[calc(100dvh-3.5rem)] overflow-hidden sm:-m-6">
      {/* Rail de sesiones — solo lg+ (en móvil manda el chat). */}
      <div className="hidden lg:block">
        <SessionList
          sessions={sessions}
          activeId={activeId}
          onSelect={(id) => selectSession(id)}
          onNew={() => selectSession(null)}
          onDelete={handleDelete}
        />
      </div>

      <div className="flex min-w-0 flex-1 flex-col bg-background">
        {/* Header del chat (móvil: acceso a nueva conversación). */}
        <div className="flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
          <div className="flex min-w-0 items-center gap-2">
            <Sparkles className="h-4 w-4 shrink-0 text-primary" />
            <span className="truncate text-sm font-medium text-foreground">
              {activeId
                ? (sessions.find((s) => s.id === activeId)?.title ?? 'Concierge')
                : 'Nueva conversación'}
            </span>
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => selectSession(null)}
              className="lg:hidden"
            >
              <Plus className="mr-1 h-4 w-4" /> Nueva
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="hidden text-muted-foreground sm:inline-flex"
              render={<Link href="/agents" />}
            >
              Configurar agente
            </Button>
          </div>
        </div>

        <ChatThread
          messages={chat.messages}
          actions={chat.actions}
          sending={chat.sending}
          statusLabel={chat.statusLabel}
          loadingHistory={chat.loadingHistory}
          userName={profile?.full_name ?? null}
          onSuggestion={(s) => void handleSend(s)}
          onConfirmAction={chat.confirmAction}
          onCancelAction={chat.cancelAction}
        />

        <Composer
          value={input}
          onChange={setInput}
          onSend={() => void handleSend()}
          sending={chat.sending}
        />
      </div>
    </div>
  );
}
