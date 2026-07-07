'use client';

import Link from 'next/link';
import { ArrowUpRight, CalendarDays } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { AgendaBlock, ConciergeBlock, NavigateBlock } from '@/lib/ai/concierge/blocks';

// ============================================================
// Render de los bloques estructurados del Concierge dentro del
// transcript: el widget de agenda (tabla de citas del día) y el chip
// de navegación. Mismo lenguaje visual que las action cards.
// ============================================================

const ESTADO_CHIP: Record<string, string> = {
  pendiente: 'bg-warning/10 text-warning',
  confirmada: 'bg-success/10 text-success',
  completada: 'bg-primary/10 text-primary',
  cancelada: 'bg-muted text-muted-foreground',
  no_asistio: 'bg-destructive/10 text-destructive',
};

const ESTADO_CORTO: Record<string, string> = {
  pendiente: 'pendiente',
  confirmada: 'confirmada',
  completada: 'completada',
  cancelada: 'cancelada',
  no_asistio: 'no asistió',
};

/** "2026-07-08" → "mié 8 jul" (fecha de pared, sin líos de zona). */
function fechaLabel(fecha: string): string {
  const m = fecha.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return fecha;
  return new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString('es-MX', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
}

/** La hora ya viene formateada del server ("mié 8 jul, 10:00"); para la
 *  columna compacta basta el tramo de hora. */
function horaCorta(hora: string): string {
  const m = hora.match(/(\d{1,2}:\d{2})\s*$/);
  return m ? m[1] : hora;
}

function AgendaBlockView({ block }: { block: AgendaBlock }) {
  return (
    <div className="w-full max-w-md overflow-hidden rounded-xl border border-border bg-card shadow-sm">
      <div className="flex items-center justify-between border-b border-border px-3.5 py-2.5">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <CalendarDays className="h-3.5 w-3.5" />
          </div>
          <p className="text-sm font-medium text-foreground">
            Agenda · {fechaLabel(block.fecha)}
          </p>
        </div>
        <span className="text-xs text-muted-foreground">
          {block.citas.length === 1 ? '1 cita' : `${block.citas.length} citas`}
        </span>
      </div>

      {block.citas.length === 0 ? (
        <p className="px-3.5 py-4 text-sm text-muted-foreground">
          Sin citas agendadas este día.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {block.citas.map((cita) => (
            <li key={cita.appointment_id} className="flex items-center gap-3 px-3.5 py-2">
              <span className="nums w-11 shrink-0 text-xs font-medium text-foreground">
                {horaCorta(cita.hora)}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-foreground">{cita.paciente}</p>
                {cita.tipo && (
                  <p className="truncate text-[11px] text-muted-foreground">{cita.tipo}</p>
                )}
              </div>
              {cita.anticipo_estado === 'pendiente' && (
                <span className="shrink-0 rounded-full bg-warning/10 px-2 py-0.5 text-[10px] font-medium text-warning">
                  anticipo
                </span>
              )}
              <span
                className={cn(
                  'shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium',
                  ESTADO_CHIP[cita.estado] ?? 'bg-muted text-muted-foreground',
                )}
              >
                {ESTADO_CORTO[cita.estado] ?? cita.estado}
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="border-t border-border px-3.5 py-2">
        <Link
          href="/calendario"
          className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
        >
          Abrir calendario <ArrowUpRight className="h-3 w-3" />
        </Link>
      </div>
    </div>
  );
}

function NavigateChip({ block }: { block: NavigateBlock }) {
  return (
    <Link
      href={block.href}
      className="inline-flex w-fit items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
    >
      <ArrowUpRight className="h-3 w-3 text-primary" />
      Abrió {block.label}
    </Link>
  );
}

export function BlockView({ block }: { block: ConciergeBlock }) {
  switch (block.kind) {
    case 'agenda':
      return <AgendaBlockView block={block} />;
    case 'navegacion':
      return <NavigateChip block={block} />;
    default:
      return null;
  }
}
