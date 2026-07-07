'use client';

import { Plus, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

// ============================================================
// Rail de sesiones del Concierge, agrupadas por fecha relativa
// (Hoy / Ayer / Anteriores). En pantallas <lg se colapsa: la página lo
// oculta y ofrece "nueva conversación" desde el header del chat.
// ============================================================

export interface SessionSummary {
  id: string;
  title: string | null;
  last_message_at: string;
}

interface SessionListProps {
  sessions: SessionSummary[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
}

function groupLabel(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const startOfDay = (x: Date) =>
    new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
  if (diffDays <= 0) return 'Hoy';
  if (diffDays === 1) return 'Ayer';
  return 'Anteriores';
}

export function SessionList({
  sessions,
  activeId,
  onSelect,
  onNew,
  onDelete,
}: SessionListProps) {
  const groups: { label: string; items: SessionSummary[] }[] = [];
  for (const s of sessions) {
    const label = groupLabel(s.last_message_at);
    const group = groups.find((g) => g.label === label);
    if (group) group.items.push(s);
    else groups.push({ label, items: [s] });
  }

  return (
    <div className="flex h-full w-60 shrink-0 flex-col border-r border-border bg-card/50">
      <div className="p-3">
        <Button variant="outline" size="sm" className="w-full justify-start" onClick={onNew}>
          <Plus className="mr-1.5 h-4 w-4" /> Nueva conversación
        </Button>
      </div>
      <div className="flex-1 overflow-y-auto px-2 pb-3">
        {groups.map((g) => (
          <div key={g.label} className="mb-2">
            <p className="px-2 py-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              {g.label}
            </p>
            <ul className="flex flex-col gap-0.5">
              {g.items.map((s) => (
                <li key={s.id} className="group relative">
                  <button
                    type="button"
                    onClick={() => onSelect(s.id)}
                    className={cn(
                      'w-full truncate rounded-lg px-2.5 py-2 pr-8 text-left text-sm transition-colors',
                      activeId === s.id
                        ? 'bg-primary/10 text-primary'
                        : 'text-foreground hover:bg-muted',
                    )}
                  >
                    {s.title || 'Sin título'}
                  </button>
                  <button
                    type="button"
                    aria-label="Eliminar conversación"
                    onClick={() => onDelete(s.id)}
                    className="absolute right-1.5 top-1/2 hidden h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive group-hover:flex"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
        {sessions.length === 0 && (
          <p className="px-2 py-4 text-center text-xs text-muted-foreground">
            Aún no hay conversaciones.
          </p>
        )}
      </div>
    </div>
  );
}
