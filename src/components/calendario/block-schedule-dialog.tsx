"use client";

/**
 * BlockScheduleDialog — bloquear un rango de agenda (cirugía, comida,
 * vacaciones). Soporta rangos multi-día; el calendario los pinta
 * recortados por día con patrón rayado.
 */

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2 } from "lucide-react";
import { toDateInputValue } from "@/lib/clinic/calendar";

interface BlockScheduleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Día precargado (el día visible del calendario). */
  defaultDate: Date;
  onCreated: () => void;
}

export function BlockScheduleDialog({
  open,
  onOpenChange,
  defaultDate,
  onCreated,
}: BlockScheduleDialogProps) {
  const supabase = createClient();
  const { accountId } = useAuth();

  const [startDate, setStartDate] = useState("");
  const [startTime, setStartTime] = useState("09:00");
  const [endDate, setEndDate] = useState("");
  const [endTime, setEndTime] = useState("14:00");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      const day = toDateInputValue(defaultDate);
      setStartDate(day);
      setEndDate(day);
      setStartTime("09:00");
      setEndTime("14:00");
      setReason("");
    }
  }, [open, defaultDate]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    const starts = new Date(`${startDate}T${startTime}`);
    const ends = new Date(`${endDate}T${endTime}`);
    if (Number.isNaN(starts.getTime()) || Number.isNaN(ends.getTime())) {
      toast.error("Fecha u hora inválidas");
      return;
    }
    if (ends <= starts) {
      toast.error("El fin del bloqueo debe ser después del inicio");
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

      const { error } = await supabase.from("schedule_blocks").insert({
        account_id: accountId,
        starts_at: starts.toISOString(),
        ends_at: ends.toISOString(),
        reason: reason.trim() || null,
        created_by: user.id,
      });
      if (error) throw error;

      toast.success("Horario bloqueado");
      onOpenChange(false);
      onCreated();
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "No se pudo bloquear el horario";
      toast.error(message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-border bg-popover text-popover-foreground sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">
            Bloquear horario
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            El rango bloqueado se muestra rayado en el calendario (cirugías,
            comidas, vacaciones).
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="bs-start-date" className="text-muted-foreground">
                Desde
              </Label>
              <Input
                id="bs-start-date"
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="nums border-border bg-muted text-foreground"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="bs-start-time" className="text-muted-foreground">
                Hora
              </Label>
              <Input
                id="bs-start-time"
                type="time"
                step={300}
                value={startTime}
                onChange={(e) => setStartTime(e.target.value)}
                className="nums border-border bg-muted text-foreground"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="bs-end-date" className="text-muted-foreground">
                Hasta
              </Label>
              <Input
                id="bs-end-date"
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="nums border-border bg-muted text-foreground"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="bs-end-time" className="text-muted-foreground">
                Hora
              </Label>
              <Input
                id="bs-end-time"
                type="time"
                step={300}
                value={endTime}
                onChange={(e) => setEndTime(e.target.value)}
                className="nums border-border bg-muted text-foreground"
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="bs-reason" className="text-muted-foreground">
              Motivo
            </Label>
            <Input
              id="bs-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Cirugía, comida, vacaciones…"
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
              Bloquear
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
