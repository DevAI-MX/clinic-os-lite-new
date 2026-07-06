import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { StatusMeta, Tone } from "@/lib/clinic/status-maps";

/**
 * StatusBadge — badge de estado de negocio por "tone".
 *
 * Adaptado del legacy (docs/legacy-clinicos/ui/status-badge.tsx),
 * construido encima del <Badge> de shadcn para heredar tamaño y foco.
 * TODOS los estados clínicos se pintan con esto (vía los mapas de
 * @/lib/clinic/status-maps) para que "Confirmada" se vea IGUAL en
 * calendario, CRM y finanzas.
 */

const TONE_CLASSES: Record<Tone, string> = {
  success: "border-success/25 bg-success/12 text-success",
  warning:
    "border-warning/30 bg-warning/14 text-warning-foreground dark:text-warning",
  destructive: "border-destructive/25 bg-destructive/10 text-destructive",
  primary: "border-primary/25 bg-primary/10 text-primary",
  muted: "border-border bg-muted text-muted-foreground",
};

const DOT_CLASSES: Record<Tone, string> = {
  success: "bg-success",
  warning: "bg-warning",
  destructive: "bg-destructive",
  primary: "bg-primary",
  muted: "bg-muted-foreground",
};

interface StatusBadgeProps {
  tone: Tone;
  children: ReactNode;
  /** Punto de color a la izquierda (con `pulse` para estados "vivos"). */
  dot?: boolean;
  pulse?: boolean;
  className?: string;
}

export function StatusBadge({
  tone,
  children,
  dot = false,
  pulse = false,
  className,
}: StatusBadgeProps) {
  return (
    <Badge
      variant="outline"
      className={cn("gap-1.5 rounded-full", TONE_CLASSES[tone], className)}
    >
      {dot && (
        <span
          aria-hidden
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            DOT_CLASSES[tone],
            pulse && "animate-pulse-dot",
          )}
        />
      )}
      {children}
    </Badge>
  );
}

/** Atajo: badge directo desde un StatusMeta de @/lib/clinic/status-maps. */
export function MetaBadge({
  meta,
  dot,
  pulse,
  className,
}: {
  meta: StatusMeta;
  dot?: boolean;
  pulse?: boolean;
  className?: string;
}) {
  return (
    <StatusBadge tone={meta.tone} dot={dot} pulse={pulse} className={className}>
      {meta.label}
    </StatusBadge>
  );
}
