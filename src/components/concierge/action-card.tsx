'use client';

import {
  CalendarDays,
  CheckCircle2,
  CircleDollarSign,
  FileText,
  Kanban,
  Loader2,
  ShieldAlert,
  XCircle,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import type { ConciergeAction } from './use-concierge-chat';

// ============================================================
// Action Card — la tarjeta de confirmación del Concierge.
//
// Pinta la máquina de estados completa (§ diseño): proposed (botones),
// executing (spinner), executed (banda success), failed (banda
// destructive), cancelled/expired (atenuada). El footer de proposed
// recuerda la regla de oro: nada se ejecuta sin confirmar.
// ============================================================

const TOOL_ICON: Record<string, typeof CalendarDays> = {
  agendar_cita: CalendarDays,
  reagendar_cita: CalendarDays,
  actualizar_estado_cita: CalendarDays,
  validar_anticipo: CircleDollarSign,
  mover_deal: Kanban,
  crear_nota_paciente: FileText,
};

interface ActionCardProps {
  action: ConciergeAction;
  onConfirm: (id: string) => void;
  onCancel: (id: string) => void;
}

export function ActionCard({ action, onConfirm, onCancel }: ActionCardProps) {
  const Icon = TOOL_ICON[action.toolName] ?? CalendarDays;
  const muted = action.status === 'cancelled' || action.status === 'expired';

  return (
    <div
      className={cn(
        'w-full max-w-md rounded-xl border border-border bg-card shadow-sm',
        muted && 'opacity-60',
      )}
    >
      <div className="flex items-start gap-3 p-3.5">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Icon className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground">{action.summary}</p>
          {Object.keys(action.details).length > 0 && (
            <dl className="mt-2 space-y-1">
              {Object.entries(action.details).map(([k, v]) => (
                <div key={k} className="flex gap-2 text-xs">
                  <dt className="w-24 shrink-0 text-muted-foreground">{k}</dt>
                  <dd className="min-w-0 break-words text-foreground">{v}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      </div>

      {action.status === 'proposed' && (
        <div className="border-t border-border px-3.5 py-2.5">
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={() => onConfirm(action.id)}>
              Confirmar
            </Button>
            <Button size="sm" variant="ghost" onClick={() => onCancel(action.id)}>
              Cancelar
            </Button>
          </div>
          <p className="mt-2 text-[11px] text-muted-foreground">
            Esta acción no se ejecuta hasta que confirmes.
          </p>
        </div>
      )}

      {action.status === 'executing' && (
        <div className="flex items-center gap-2 border-t border-border px-3.5 py-2.5 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Ejecutando…
        </div>
      )}

      {action.status === 'executed' && (
        <div className="flex items-center gap-2 rounded-b-xl border-t border-success/25 bg-success/10 px-3.5 py-2.5 text-sm text-success">
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          <span>{action.resultMessage ?? 'Acción ejecutada.'}</span>
        </div>
      )}

      {action.status === 'failed' && (
        <div className="flex items-center gap-2 rounded-b-xl border-t border-destructive/25 bg-destructive/10 px-3.5 py-2.5 text-sm text-destructive">
          <ShieldAlert className="h-4 w-4 shrink-0" />
          <span>{action.error ?? 'La acción falló al ejecutarse.'}</span>
        </div>
      )}

      {muted && (
        <div className="flex items-center gap-2 border-t border-border px-3.5 py-2.5 text-sm text-muted-foreground">
          <XCircle className="h-4 w-4 shrink-0" />
          <span>{action.status === 'cancelled' ? 'Cancelada.' : 'Expirada — pide al Concierge proponerla de nuevo.'}</span>
        </div>
      )}
    </div>
  );
}
