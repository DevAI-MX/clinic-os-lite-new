"use client";

/**
 * Calendario — módulo V1 de clinicOS.
 *
 * Ensambla el hook useAgenda (datos + realtime) con la rejilla horaria,
 * el strip de KPIs y los diálogos de nueva cita / bloqueo / detalle.
 * Vista semana (default, lun→dom) y vista día, con navegación
 * anterior / hoy / siguiente. El look sigue el tema porcelana/petróleo
 * de clinicOS (bg-card, shadow-soft, badges por tono).
 */

import { useMemo, useState } from "react";
import {
  CalendarDays,
  CalendarPlus,
  ChevronLeft,
  ChevronRight,
  Lock,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useAgenda } from "@/components/calendario/use-agenda";
import { KpiStrip } from "@/components/calendario/kpi-strip";
import { CalendarGrid } from "@/components/calendario/calendar-grid";
import { NewAppointmentDialog } from "@/components/calendario/new-appointment-dialog";
import { BlockScheduleDialog } from "@/components/calendario/block-schedule-dialog";
import { AppointmentSheet } from "@/components/calendario/appointment-sheet";
import {
  addDays,
  formatDayLong,
  formatWeekRange,
  mondayOf,
  startOfDay,
  weekDays,
} from "@/lib/clinic/calendar";

type ViewMode = "semana" | "dia";

export default function CalendarioPage() {
  const [view, setView] = useState<ViewMode>("semana");
  // Ancla de navegación: para "semana" se normaliza al lunes; para "día"
  // es el día mismo (medianoche local).
  const [anchor, setAnchor] = useState<Date>(() => startOfDay(new Date()));
  const [newOpen, setNewOpen] = useState(false);
  const [blockOpen, setBlockOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Días visibles + rango [inicio, fin) que pide el hook.
  const { days, rangeStart, rangeEnd } = useMemo(() => {
    if (view === "dia") {
      const d = startOfDay(anchor);
      return { days: [d], rangeStart: d, rangeEnd: addDays(d, 1) };
    }
    const monday = mondayOf(anchor);
    return {
      days: weekDays(monday),
      rangeStart: monday,
      rangeEnd: addDays(monday, 7),
    };
  }, [view, anchor]);

  const { appointments, blocks, procedures, kpis, loading, refetch } =
    useAgenda(rangeStart, rangeEnd);

  const selected =
    appointments.find((a) => a.id === selectedId) ?? null;

  const now = new Date();

  const goPrev = () =>
    setAnchor((a) => addDays(a, view === "dia" ? -1 : -7));
  const goNext = () =>
    setAnchor((a) => addDays(a, view === "dia" ? 1 : 7));
  const goToday = () => setAnchor(startOfDay(new Date()));

  const rangeLabel =
    view === "dia" ? formatDayLong(days[0]) : formatWeekRange(anchor);

  return (
    <div className="flex h-full flex-col gap-4">
      {/* Encabezado */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <CalendarDays className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-lg font-semibold tracking-tight text-foreground">
              Calendario
            </h1>
            <p className="text-xs capitalize text-muted-foreground">
              {rangeLabel}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setBlockOpen(true)}
            className="gap-1.5"
          >
            <Lock className="h-4 w-4" />
            <span className="hidden sm:inline">Bloquear horario</span>
          </Button>
          <Button
            size="sm"
            onClick={() => setNewOpen(true)}
            className="gap-1.5"
          >
            <CalendarPlus className="h-4 w-4" />
            Nueva cita
          </Button>
        </div>
      </div>

      {/* KPIs */}
      <KpiStrip kpis={kpis} loading={loading} />

      {/* Controles de navegación / vista */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8"
            onClick={goPrev}
            aria-label="Anterior"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-8"
            onClick={goToday}
          >
            Hoy
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8"
            onClick={goNext}
            aria-label="Siguiente"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>

        {/* Control segmentado semana/día — pista gris + pastilla activa,
            el estilo homologado del legacy (docs/legacy-clinicos/ui/segment.ts). */}
        <div className="flex h-8 items-center gap-0.5 rounded-lg bg-muted p-[3px]">
          {(["semana", "dia"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => setView(mode)}
              className={cn(
                "h-full rounded-md px-3 text-xs font-medium transition-all",
                view === mode
                  ? "bg-background text-foreground shadow-sm"
                  : "text-foreground/60 hover:text-foreground",
              )}
            >
              {mode === "semana" ? "Semana" : "Día"}
            </button>
          ))}
        </div>
      </div>

      {/* Rejilla */}
      <div className="min-h-0 flex-1 animate-fade-up overflow-hidden rounded-xl border border-border bg-card shadow-soft">
        <CalendarGrid
          days={days}
          appointments={appointments}
          blocks={blocks}
          now={now}
          onSelectAppointment={setSelectedId}
          onSelectDay={(day) => {
            setView("dia");
            setAnchor(startOfDay(day));
          }}
        />
      </div>

      {/* Diálogos */}
      <NewAppointmentDialog
        open={newOpen}
        onOpenChange={setNewOpen}
        procedures={procedures}
        defaultDate={days[0]}
        onCreated={refetch}
      />
      <BlockScheduleDialog
        open={blockOpen}
        onOpenChange={setBlockOpen}
        defaultDate={days[0]}
        onCreated={refetch}
      />
      <AppointmentSheet
        appointment={selected}
        open={selectedId !== null}
        onOpenChange={(o) => {
          if (!o) setSelectedId(null);
        }}
        onChanged={refetch}
      />
    </div>
  );
}
