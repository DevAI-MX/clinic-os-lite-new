"use client";

/**
 * NewAppointmentDialog — agendar una cita nueva.
 *
 * Regla de anticipo (migración 031): si el procedimiento elegido tiene
 * `deposit_amount`, la cita nace status='pendiente' + deposit_status=
 * 'pendiente' con snapshot del monto; sin anticipo requerido nace
 * 'confirmada' con deposit_status='no_aplica'.
 */

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { nudgeCalendarSync } from "@/lib/integrations/google/nudge-client";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Loader2 } from "lucide-react";
import { ContactCombobox } from "./contact-combobox";
import { formatCurrency } from "@/lib/currency";
import { toDateInputValue } from "@/lib/clinic/calendar";
import { APPOINTMENT_TYPE_LABEL } from "@/lib/clinic/status-maps";
import {
  CLINIC_CURRENCY,
  type AppointmentContact,
  type AppointmentType,
  type Doctor,
  type Procedure,
} from "@/lib/clinic/types";

/** Valor centinela del select para "cita sin procedimiento del catálogo". */
const NO_PROCEDURE = "none";

/** Valor centinela del select para "cita sin doctor asignado". */
const NO_DOCTOR = "none";

const TYPE_OPTIONS = Object.entries(APPOINTMENT_TYPE_LABEL) as [
  AppointmentType,
  string,
][];

interface NewAppointmentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  procedures: Procedure[];
  /** Doctores asignables (perfiles con is_provider). Vacío = clínica de
   *  un solo doctor: el selector no se muestra. */
  doctors: Doctor[];
  /** Día precargado en el formulario (el día visible del calendario). */
  defaultDate: Date;
  onCreated: () => void;
}

export function NewAppointmentDialog({
  open,
  onOpenChange,
  procedures,
  doctors,
  defaultDate,
  onCreated,
}: NewAppointmentDialogProps) {
  const supabase = createClient();
  const { accountId } = useAuth();

  const [contact, setContact] = useState<AppointmentContact | null>(null);
  const [procedureId, setProcedureId] = useState<string>(NO_PROCEDURE);
  const [doctorId, setDoctorId] = useState<string>(NO_DOCTOR);
  const [type, setType] = useState<AppointmentType>("valoracion");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("10:00");
  const [duration, setDuration] = useState(60);
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  // Reset al abrir, con el día visible del calendario precargado.
  useEffect(() => {
    if (open) {
      setContact(null);
      setProcedureId(NO_PROCEDURE);
      setDoctorId(NO_DOCTOR);
      setType("valoracion");
      setDate(toDateInputValue(defaultDate));
      setTime("10:00");
      setDuration(60);
      setNotes("");
    }
  }, [open, defaultDate]);

  const procedure =
    procedureId === NO_PROCEDURE
      ? null
      : (procedures.find((p) => p.id === procedureId) ?? null);
  const requiresDeposit = !!procedure?.deposit_amount;

  const procedureItems: Record<string, string> = {
    [NO_PROCEDURE]: "Sin procedimiento",
    ...Object.fromEntries(procedures.map((p) => [p.id, p.name])),
  };

  function handleProcedureChange(id: string) {
    setProcedureId(id);
    const proc = procedures.find((p) => p.id === id);
    // Al elegir procedimiento se precarga su duración (el anticipo se
    // muestra como aviso y se snapshotea al guardar).
    if (proc) setDuration(proc.duration_minutes);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    if (!contact) {
      toast.error("Selecciona un contacto");
      return;
    }
    if (!date || !time) {
      toast.error("Indica fecha y hora");
      return;
    }
    const starts = new Date(`${date}T${time}`);
    if (Number.isNaN(starts.getTime())) {
      toast.error("Fecha u hora inválidas");
      return;
    }
    if (!Number.isFinite(duration) || duration < 5 || duration > 720) {
      toast.error("La duración debe estar entre 5 y 720 minutos");
      return;
    }

    setSaving(true);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const user = session?.user;
      if (!user) throw new Error("Sesión no válida");
      if (!accountId) throw new Error("Tu perfil no está ligado a una cuenta");

      const ends = new Date(starts.getTime() + duration * 60_000);

      const { error } = await supabase.from("appointments").insert({
        account_id: accountId,
        contact_id: contact.id,
        procedure_id: procedure?.id ?? null,
        doctor_id: doctorId === NO_DOCTOR ? null : doctorId,
        appointment_type: type,
        // Regla de oro: con anticipo requerido la cita espera el pago.
        status: requiresDeposit ? "pendiente" : "confirmada",
        deposit_status: requiresDeposit ? "pendiente" : "no_aplica",
        deposit_amount: requiresDeposit ? procedure!.deposit_amount : null,
        starts_at: starts.toISOString(),
        ends_at: ends.toISOString(),
        notes: notes.trim() || null,
        created_by: user.id,
      });
      if (error) throw error;

      // Refleja la cita nueva en Google Calendar casi al instante; si
      // falla, el cron de respaldo la sincroniza en el siguiente barrido.
      nudgeCalendarSync();

      toast.success(
        requiresDeposit
          ? "Cita creada — pendiente de anticipo"
          : "Cita creada y confirmada",
      );
      onOpenChange(false);
      onCreated();
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "No se pudo crear la cita";
      toast.error(message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-border bg-popover text-popover-foreground sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">
            Nueva cita
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            Agenda una cita para un contacto. Si el procedimiento requiere
            anticipo, la cita queda pendiente hasta confirmarlo.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label className="text-muted-foreground">
              Contacto <span className="text-destructive">*</span>
            </Label>
            <ContactCombobox value={contact} onSelect={setContact} />
          </div>

          <div className="space-y-2">
            <Label className="text-muted-foreground">Procedimiento</Label>
            <Select
              items={procedureItems}
              value={procedureId}
              onValueChange={(v) => v && handleProcedureChange(v as string)}
            >
              <SelectTrigger className="w-full border-border bg-muted text-foreground">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="border-border bg-popover">
                <SelectItem value={NO_PROCEDURE}>Sin procedimiento</SelectItem>
                {procedures.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {procedure && (
              <p className="text-xs text-muted-foreground">
                {procedure.duration_minutes} min
                {procedure.deposit_amount
                  ? ` · anticipo ${formatCurrency(procedure.deposit_amount, procedure.currency || CLINIC_CURRENCY)}`
                  : " · sin anticipo"}
              </p>
            )}
          </div>

          {doctors.length > 0 && (
            <div className="space-y-2">
              <Label className="text-muted-foreground">Doctor</Label>
              <Select
                items={{
                  [NO_DOCTOR]: "Sin asignar",
                  ...Object.fromEntries(
                    doctors.map((d) => [
                      d.user_id,
                      d.full_name || "Doctor sin nombre",
                    ]),
                  ),
                }}
                value={doctorId}
                onValueChange={(v) => v && setDoctorId(v as string)}
              >
                <SelectTrigger className="w-full border-border bg-muted text-foreground">
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
            </div>
          )}

          <div className="space-y-2">
            <Label className="text-muted-foreground">Tipo de cita</Label>
            <Select
              items={APPOINTMENT_TYPE_LABEL}
              value={type}
              onValueChange={(v) => v && setType(v as AppointmentType)}
            >
              <SelectTrigger className="w-full border-border bg-muted text-foreground">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="border-border bg-popover">
                {TYPE_OPTIONS.map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="na-date" className="text-muted-foreground">
                Fecha <span className="text-destructive">*</span>
              </Label>
              <Input
                id="na-date"
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="nums border-border bg-muted text-foreground"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="na-time" className="text-muted-foreground">
                Hora <span className="text-destructive">*</span>
              </Label>
              <Input
                id="na-time"
                type="time"
                step={300}
                value={time}
                onChange={(e) => setTime(e.target.value)}
                className="nums border-border bg-muted text-foreground"
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="na-duration" className="text-muted-foreground">
              Duración (minutos)
            </Label>
            <Input
              id="na-duration"
              type="number"
              min={5}
              max={720}
              step={5}
              value={duration}
              onChange={(e) => setDuration(Number(e.target.value))}
              className="nums border-border bg-muted text-foreground"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="na-notes" className="text-muted-foreground">
              Notas
            </Label>
            <Textarea
              id="na-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Notas internas de la cita…"
              rows={3}
              className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
            />
          </div>

          <DialogFooter className="border-border bg-popover">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              Cancelar
            </Button>
            <Button
              type="submit"
              disabled={saving}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {saving && <Loader2 className="size-4 animate-spin" />}
              Agendar cita
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
