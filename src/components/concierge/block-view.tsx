'use client';

import { useState } from 'react';
import Link from 'next/link';
import {
  ArrowUpRight,
  CalendarDays,
  CheckCircle2,
  ChevronDown,
  CircleDashed,
  ListChecks,
  Loader2,
  ShieldAlert,
  XCircle,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import type {
  AgendaBlock,
  ConciergeBlock,
  NavigateBlock,
  PlanBlock,
  PlanStepStatus,
} from '@/lib/ai/concierge/blocks';
import type { ConciergeAction } from './use-concierge-chat';

// ============================================================
// Render de los bloques estructurados del Concierge dentro del
// transcript: el widget de agenda (tabla de citas del día), el chip
// de navegación y el plan multi-paso (agrupa las propuestas de un
// turno con su botón "Confirmar plan"). Mismo lenguaje visual que las
// action cards.
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

const PLAN_STEP_LABEL: Record<PlanStepStatus, string> = {
  proposed: 'por confirmar',
  executing: 'ejecutando…',
  executed: 'hecho',
  failed: 'falló',
  cancelled: 'cancelada',
  expired: 'expirada',
};

const PLAN_STEP_CHIP: Record<PlanStepStatus, string> = {
  proposed: 'bg-warning/10 text-warning',
  executing: 'bg-primary/10 text-primary',
  executed: 'bg-success/10 text-success',
  failed: 'bg-destructive/10 text-destructive',
  cancelled: 'bg-muted text-muted-foreground',
  expired: 'bg-muted text-muted-foreground',
};

function PlanStepIcon({ status }: { status: PlanStepStatus }) {
  switch (status) {
    case 'executing':
      return <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />;
    case 'executed':
      return <CheckCircle2 className="h-3.5 w-3.5 text-success" />;
    case 'failed':
      return <ShieldAlert className="h-3.5 w-3.5 text-destructive" />;
    case 'cancelled':
    case 'expired':
      return <XCircle className="h-3.5 w-3.5 text-muted-foreground" />;
    default:
      return <CircleDashed className="h-3.5 w-3.5 text-muted-foreground" />;
  }
}

/** El estado VIVO del paso viene del mapa de acciones (realtime desde
 *  assistant_actions); el persistido en el bloque es solo el fallback
 *  para historial sin acciones cargadas. */
function liveStepStatus(
  step: PlanBlock['steps'][number],
  actions?: Record<string, ConciergeAction>,
): PlanStepStatus {
  return (actions?.[step.action_id]?.status as PlanStepStatus | undefined) ?? step.status;
}

function PlanBlockView({
  block,
  actions,
  onConfirmPlan,
}: {
  block: PlanBlock;
  actions?: Record<string, ConciergeAction>;
  onConfirmPlan?: (actionIds: string[]) => void;
}) {
  const [expandedSteps, setExpandedSteps] = useState<Set<string>>(new Set());
  const toggleStep = (actionId: string) =>
    setExpandedSteps((prev) => {
      const next = new Set(prev);
      if (next.has(actionId)) next.delete(actionId);
      else next.add(actionId);
      return next;
    });

  const statuses = block.steps.map((s) => liveStepStatus(s, actions));
  const pendingIds = block.steps
    .filter((s, i) => statuses[i] === 'proposed')
    .map((s) => s.action_id);
  const executing = statuses.some((s) => s === 'executing');
  const executed = statuses.filter((s) => s === 'executed').length;
  const failed = statuses.filter((s) => s === 'failed').length;
  const settled = pendingIds.length === 0 && !executing;

  return (
    <div className="w-full max-w-md overflow-hidden rounded-xl border border-border bg-card shadow-sm">
      <div className="flex items-center justify-between border-b border-border px-3.5 py-2.5">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <ListChecks className="h-3.5 w-3.5" />
          </div>
          <p className="text-sm font-medium text-foreground">{block.title}</p>
        </div>
        <span className="text-xs text-muted-foreground">
          {executed}/{block.steps.length} hechos
        </span>
      </div>

      <ol className="divide-y divide-border">
        {block.steps.map((step, i) => {
          const live = actions?.[step.action_id];
          const expanded = expandedSteps.has(step.action_id);
          return (
            <li key={step.action_id}>
              {/* El equipo no debe confirmar lo que no puede leer: el
                  resumen colapsado se trunca, pero cada paso se expande
                  a su contenido completo (resumen íntegro + detalles de
                  la propuesta + resultado/error). */}
              <button
                type="button"
                onClick={() => toggleStep(step.action_id)}
                aria-expanded={expanded}
                className="flex w-full items-center gap-2.5 px-3.5 py-2 text-left transition-colors hover:bg-muted/40"
              >
                <PlanStepIcon status={statuses[i]} />
                <p
                  className={cn(
                    'min-w-0 flex-1 text-sm text-foreground',
                    expanded ? 'whitespace-pre-wrap break-words' : 'truncate',
                  )}
                >
                  {step.summary}
                </p>
                <span
                  className={cn(
                    'shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium',
                    PLAN_STEP_CHIP[statuses[i]],
                  )}
                >
                  {PLAN_STEP_LABEL[statuses[i]]}
                </span>
                <ChevronDown
                  className={cn(
                    'h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform',
                    expanded && 'rotate-180',
                  )}
                />
              </button>
              {expanded && (
                <div className="space-y-1.5 px-3.5 pb-2.5 pl-9">
                  {live && Object.entries(live.details).length > 0 && (
                    <dl className="space-y-0.5">
                      {Object.entries(live.details).map(([k, v]) => (
                        <div key={k} className="flex gap-2 text-xs">
                          <dt className="shrink-0 text-muted-foreground">{k}:</dt>
                          <dd className="min-w-0 break-words text-foreground">{v}</dd>
                        </div>
                      ))}
                    </dl>
                  )}
                  {statuses[i] === 'executed' && live?.resultMessage && (
                    <p className="text-xs text-success">{live.resultMessage}</p>
                  )}
                  {statuses[i] === 'failed' && (
                    <p className="text-xs text-destructive">
                      {live?.error ?? 'La acción falló al ejecutarse.'}
                    </p>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ol>

      {pendingIds.length > 0 && (
        <div className="border-t border-border px-3.5 py-2.5">
          <Button size="sm" onClick={() => onConfirmPlan?.(pendingIds)} disabled={!onConfirmPlan}>
            Confirmar plan ({pendingIds.length})
          </Button>
          <p className="mt-2 text-[11px] text-muted-foreground">
            Ejecuta los pasos en orden. También puedes confirmar o cancelar cada
            uno en su tarjeta — nada corre sin tu confirmación.
          </p>
        </div>
      )}

      {executing && pendingIds.length === 0 && (
        <div className="flex items-center gap-2 border-t border-border px-3.5 py-2.5 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Ejecutando plan…
        </div>
      )}

      {settled && (executed > 0 || failed > 0) && (
        <div
          className={cn(
            'flex items-center gap-2 rounded-b-xl border-t px-3.5 py-2.5 text-sm',
            failed > 0
              ? 'border-destructive/25 bg-destructive/10 text-destructive'
              : 'border-success/25 bg-success/10 text-success',
          )}
        >
          {failed > 0 ? (
            <ShieldAlert className="h-4 w-4 shrink-0" />
          ) : (
            <CheckCircle2 className="h-4 w-4 shrink-0" />
          )}
          <span>
            {failed > 0
              ? `Plan terminado: ${executed} de ${block.steps.length} pasos ejecutados, ${failed} con error.`
              : `Plan completado: ${executed} de ${block.steps.length} pasos ejecutados.`}
          </span>
        </div>
      )}
      {settled && executed === 0 && failed === 0 && (
        <div className="flex items-center gap-2 border-t border-border px-3.5 py-2.5 text-sm text-muted-foreground">
          <XCircle className="h-4 w-4 shrink-0" />
          <span>Plan sin ejecutar: sus pasos fueron cancelados o expiraron.</span>
        </div>
      )}
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

export function BlockView({
  block,
  actions,
  onConfirmPlan,
}: {
  block: ConciergeBlock;
  /** Mapa vivo de acciones (para el estado de los pasos del plan). */
  actions?: Record<string, ConciergeAction>;
  /** "Confirmar plan": ejecuta las propuestas pendientes en orden. */
  onConfirmPlan?: (actionIds: string[]) => void;
}) {
  switch (block.kind) {
    case 'agenda':
      return <AgendaBlockView block={block} />;
    case 'navegacion':
      return <NavigateChip block={block} />;
    case 'plan':
      return <PlanBlockView block={block} actions={actions} onConfirmPlan={onConfirmPlan} />;
    default:
      return null;
  }
}
