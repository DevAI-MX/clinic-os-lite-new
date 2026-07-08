"use client";

/**
 * AppointmentSheet — detalle lateral de una cita con sus acciones.
 *
 * Regla de oro del legacy (migración 031): la IA solo PREVALIDA pagos;
 * un humano los confirma aquí. "Marcar anticipo pagado" confirma (o
 * crea) el Payment, pone deposit_status='pagado' y sube la cita de
 * 'pendiente' a 'confirmada'.
 */

import { useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { nudgeCalendarSync } from "@/lib/integrations/google/nudge-client";
import { toast } from "sonner";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { MetaBadge } from "@/components/shared/status-badge";
import { useCan } from "@/hooks/use-can";
import { formatCurrency } from "@/lib/currency";
import { formatDayLong, formatTime } from "@/lib/clinic/calendar";
import {
  APPOINTMENT_STATUS,
  APPOINTMENT_TYPE_LABEL,
  DEPOSIT_STATUS,
} from "@/lib/clinic/status-maps";
import {
  CLINIC_CURRENCY,
  type AppointmentStatus,
  type AppointmentWithRelations,
  type Doctor,
} from "@/lib/clinic/types";
import {
  BanknoteIcon,
  CalendarClock,
  CheckCheck,
  CheckCircle2,
  ExternalLink,
  Loader2,
  Phone,
  Stethoscope,
  User,
  UserRound,
  XCircle,
} from "lucide-react";

/** Centinela del select de doctor para "sin asignar". */
const NO_DOCTOR = "none";

interface AppointmentSheetProps {
  appointment: AppointmentWithRelations | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Doctores asignables (perfiles con is_provider). Vacío = no se
   *  muestra el selector de doctor. */
  doctors: Doctor[];
  /** Refresca la agenda tras una acción (el sheet queda abierto y se
   *  re-renderiza con la cita actualizada que le pasa el padre). */
  onChanged: () => void;
}

export function AppointmentSheet({
  appointment,
  open,
  onOpenChange,
  doctors,
  onChanged,
}: AppointmentSheetProps) {
  const supabase = createClient();
  const canAct = useCan("send-messages");
  /** Acción en curso, para el spinner del botón correspondiente. */
  const [pending, setPending] = useState<string | null>(null);

  async function updateStatus(status: AppointmentStatus, message: string) {
    if (!appointment) return;
    setPending(status);
    const { error } = await supabase
      .from("appointments")
      .update({ status })
      .eq("id", appointment.id);
    if (error) {
      toast.error("No se pudo actualizar la cita");
    } else {
      toast.success(message);
      onChanged();
      // Propaga el nuevo estado (o el borrado, si se canceló) a Google.
      nudgeCalendarSync();
    }
    setPending(null);
  }

  async function updateDoctor(nextDoctorId: string) {
    if (!appointment) return;
    const doctorId = nextDoctorId === NO_DOCTOR ? null : nextDoctorId;
    if (doctorId === appointment.doctor_id) return;
    setPending("doctor");
    const { error } = await supabase
      .from("appointments")
      .update({ doctor_id: doctorId })
      .eq("id", appointment.id);
    if (error) {
      toast.error("No se pudo reasignar el doctor");
    } else {
      toast.success(doctorId ? "Doctor asignado" : "Doctor quitado");
      onChanged();
      // El color del evento en Google depende del doctor: resincroniza.
      nudgeCalendarSync();
    }
    setPending(null);
  }

  /**
   * Confirma el anticipo: Payment → 'confirmado' (actualiza el
   * prevalidado por la IA o crea uno nuevo), deposit_status='pagado' y
   * la cita pendiente pasa a 'confirmada'.
   */
  async function markDepositPaid() {
    if (!appointment) return;
    setPending("deposit");
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const user = session?.user;
      if (!user) throw new Error("Sesión no válida");

      const nowIso = new Date().toISOString();
      const amount = Number(appointment.deposit_amount) || 0;

      // ¿Ya existe un pago ligado a la cita (p. ej. prevalidado por la IA)?
      const { data: existing, error: lookupError } = await supabase
        .from("payments")
        .select("id, status")
        .eq("appointment_id", appointment.id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (lookupError) throw lookupError;

      if (existing) {
        if (existing.status !== "confirmado") {
          const { error } = await supabase
            .from("payments")
            .update({
              status: "confirmado",
              confirmed_by: user.id,
              confirmed_at: nowIso,
            })
            .eq("id", existing.id);
          if (error) throw error;
        }
      } else if (amount > 0) {
        const { error } = await supabase.from("payments").insert({
          account_id: appointment.account_id,
          contact_id: appointment.contact_id,
          appointment_id: appointment.id,
          amount,
          currency: appointment.procedure?.currency || CLINIC_CURRENCY,
          method: "transferencia",
          status: "confirmado",
          concept: appointment.procedure
            ? `Anticipo · ${appointment.procedure.name}`
            : "Anticipo de cita",
          confirmed_by: user.id,
          confirmed_at: nowIso,
        });
        if (error) throw error;
      }

      const { error: apptError } = await supabase
        .from("appointments")
        .update({
          deposit_status: "pagado",
          // Solo sube pendiente → confirmada; no degrada una completada.
          ...(appointment.status === "pendiente"
            ? { status: "confirmada" }
            : {}),
        })
        .eq("id", appointment.id);
      if (apptError) throw apptError;

      toast.success("Anticipo confirmado — cita confirmada");
      onChanged();
      // La cita pasó a 'confirmada' (tentative → confirmed en Google).
      nudgeCalendarSync();
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "No se pudo confirmar el anticipo";
      toast.error(message);
    } finally {
      setPending(null);
    }
  }

  if (!appointment) return null;

  const starts = new Date(appointment.starts_at);
  const ends = new Date(appointment.ends_at);
  const statusMeta = APPOINTMENT_STATUS[appointment.status];
  const depositMeta = DEPOSIT_STATUS[appointment.deposit_status];
  const isActive =
    appointment.status === "pendiente" || appointment.status === "confirmada";

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-md">
        <SheetHeader className="pb-0">
          <div className="flex items-center gap-2 pr-8">
            <SheetTitle className="truncate">
              {appointment.contact?.name ||
                appointment.contact?.phone ||
                "Cita"}
            </SheetTitle>
            <MetaBadge
              meta={statusMeta}
              dot
              pulse={appointment.status === "pendiente"}
            />
          </div>
          <SheetDescription>
            {APPOINTMENT_TYPE_LABEL[appointment.appointment_type]}
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 space-y-5 overflow-y-auto px-4">
          {/* Fecha y hora */}
          <div className="flex items-start gap-2.5">
            <CalendarClock className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <div>
              <p className="text-sm font-medium text-foreground first-letter:uppercase">
                {formatDayLong(starts)}
              </p>
              <p className="nums text-sm text-muted-foreground">
                {formatTime(starts)} – {formatTime(ends)}
              </p>
            </div>
          </div>

          <Separator className="bg-border" />

          {/* Contacto */}
          <div className="space-y-2">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Contacto
            </p>
            <div className="flex items-center gap-2.5">
              <User className="size-4 shrink-0 text-muted-foreground" />
              <p className="truncate text-sm font-medium text-foreground">
                {appointment.contact?.name || "Sin nombre"}
              </p>
            </div>
            {appointment.contact?.phone && (
              <div className="flex items-center gap-2.5">
                <Phone className="size-4 shrink-0 text-muted-foreground" />
                <p className="nums text-sm text-muted-foreground">
                  {appointment.contact.phone}
                </p>
              </div>
            )}
            <Link
              href="/contacts"
              className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
            >
              Ver en contactos
              <ExternalLink className="size-3" />
            </Link>
          </div>

          <Separator className="bg-border" />

          {/* Procedimiento */}
          <div className="space-y-1.5">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Procedimiento
            </p>
            <div className="flex items-center gap-2.5">
              <Stethoscope className="size-4 shrink-0 text-muted-foreground" />
              <p className="text-sm text-foreground">
                {appointment.procedure?.name ?? (
                  <span className="italic text-muted-foreground">
                    Sin procedimiento
                  </span>
                )}
              </p>
            </div>
            {appointment.procedure &&
              (appointment.procedure.price_min != null ||
                appointment.procedure.price_max != null) && (
                <p className="nums pl-6.5 text-xs text-muted-foreground">
                  {formatPriceRange(
                    appointment.procedure.price_min,
                    appointment.procedure.price_max,
                    appointment.procedure.currency,
                  )}
                </p>
              )}
          </div>

          <Separator className="bg-border" />

          {/* Doctor asignado — solo cuando la clínica tiene doctores
              configurados (perfiles con is_provider). */}
          {(doctors.length > 0 || appointment.doctor_id) && (
            <>
              <Separator className="bg-border" />
              <div className="space-y-1.5">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Doctor
                </p>
                {canAct && doctors.length > 0 ? (
                  <Select
                    value={appointment.doctor_id ?? NO_DOCTOR}
                    onValueChange={(v) => v && updateDoctor(v as string)}
                  >
                    <SelectTrigger
                      className="w-full border-border bg-muted text-foreground"
                      disabled={pending !== null}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="border-border bg-popover">
                      <SelectItem value={NO_DOCTOR}>Sin asignar</SelectItem>
                      {doctors.map((d) => (
                        <SelectItem key={d.user_id} value={d.user_id}>
                          {d.full_name || "Doctor sin nombre"}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <div className="flex items-center gap-2.5">
                    <UserRound className="size-4 shrink-0 text-muted-foreground" />
                    <p className="text-sm text-foreground">
                      {doctors.find((d) => d.user_id === appointment.doctor_id)
                        ?.full_name ?? (
                        <span className="italic text-muted-foreground">
                          Sin asignar
                        </span>
                      )}
                    </p>
                  </div>
                )}
              </div>
            </>
          )}

          {/* Anticipo */}
          <div className="space-y-1.5">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Anticipo
            </p>
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2.5">
                <BanknoteIcon className="size-4 shrink-0 text-muted-foreground" />
                <p className="nums text-sm font-medium text-foreground">
                  {appointment.deposit_amount
                    ? formatCurrency(
                        appointment.deposit_amount,
                        appointment.procedure?.currency || CLINIC_CURRENCY,
                      )
                    : "—"}
                </p>
              </div>
              <MetaBadge
                meta={depositMeta}
                dot
                pulse={appointment.deposit_status === "pendiente"}
              />
            </div>
          </div>

          {/* Notas */}
          {appointment.notes && (
            <>
              <Separator className="bg-border" />
              <div className="space-y-1.5">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Notas
                </p>
                <p className="whitespace-pre-wrap text-sm text-foreground">
                  {appointment.notes}
                </p>
              </div>
            </>
          )}
        </div>

        {/* Acciones */}
        {canAct && (
          <SheetFooter className="border-t border-border">
            {appointment.deposit_status === "pendiente" && isActive && (
              <Button
                onClick={markDepositPaid}
                disabled={pending !== null}
                className="w-full bg-primary text-primary-foreground hover:bg-primary/90"
              >
                {pending === "deposit" ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <BanknoteIcon className="size-4" />
                )}
                Marcar anticipo pagado
              </Button>
            )}
            {appointment.status === "pendiente" && (
              <Button
                variant="outline"
                onClick={() => updateStatus("confirmada", "Cita confirmada")}
                disabled={pending !== null}
                className="w-full border-border"
              >
                {pending === "confirmada" ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <CheckCircle2 className="size-4" />
                )}
                Confirmar cita
              </Button>
            )}
            {isActive && (
              <Button
                variant="outline"
                onClick={() => updateStatus("completada", "Cita completada")}
                disabled={pending !== null}
                className="w-full border-border"
              >
                {pending === "completada" ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <CheckCheck className="size-4" />
                )}
                Marcar completada
              </Button>
            )}
            {isActive && (
              <Button
                variant="ghost"
                onClick={() => updateStatus("cancelada", "Cita cancelada")}
                disabled={pending !== null}
                className="w-full text-destructive hover:bg-destructive/10 hover:text-destructive"
              >
                {pending === "cancelada" ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <XCircle className="size-4" />
                )}
                Cancelar cita
              </Button>
            )}
          </SheetFooter>
        )}
      </SheetContent>
    </Sheet>
  );
}

function formatPriceRange(
  min: number | null,
  max: number | null,
  currency: string,
): string {
  const code = currency || CLINIC_CURRENCY;
  if (min != null && max != null && min !== max) {
    return `${formatCurrency(min, code)} – ${formatCurrency(max, code)}`;
  }
  const value = min ?? max;
  return value != null ? formatCurrency(value, code) : "";
}
