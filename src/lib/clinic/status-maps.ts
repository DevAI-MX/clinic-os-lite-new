/**
 * Mapas de estado de negocio → etiqueta es-MX + tono visual.
 *
 * Adaptado del legacy (docs/legacy-clinicos/ui/status-maps.ts): TODOS
 * los módulos clínicos pintan estados con esto (vía <StatusBadge> de
 * src/components/shared/status-badge.tsx) para que "Confirmada" se vea
 * IGUAL en calendario, CRM y finanzas.
 *
 * `Record<Union, …>` a propósito: un estado nuevo sin entrada NO compila.
 */
import type {
  AppointmentStatus,
  AppointmentType,
  DepositStatus,
  PaymentMethod,
  PaymentStatus,
} from "@/lib/clinic/types";

export type Tone = "success" | "warning" | "destructive" | "primary" | "muted";

export interface StatusMeta {
  label: string;
  tone: Tone;
}

/** Estado de una cita → etiqueta + tono. */
export const APPOINTMENT_STATUS: Record<AppointmentStatus, StatusMeta> = {
  pendiente: { label: "Pendiente", tone: "warning" },
  confirmada: { label: "Confirmada", tone: "primary" },
  completada: { label: "Completada", tone: "success" },
  cancelada: { label: "Cancelada", tone: "destructive" },
  no_asistio: { label: "No asistió", tone: "destructive" },
};

/** Tipo de cita → etiqueta es-MX (sin tono: es taxonomía, no estado). */
export const APPOINTMENT_TYPE_LABEL: Record<AppointmentType, string> = {
  valoracion: "Valoración",
  valoracion_virtual: "Valoración virtual",
  seguimiento: "Seguimiento",
  procedimiento: "Procedimiento",
  otro: "Otro",
};

/** Estado del anticipo de una cita → etiqueta + tono. */
export const DEPOSIT_STATUS: Record<DepositStatus, StatusMeta> = {
  no_aplica: { label: "Sin anticipo", tone: "muted" },
  pendiente: { label: "Anticipo pendiente", tone: "warning" },
  pagado: { label: "Anticipo pagado", tone: "success" },
};

/** Estado de un pago → etiqueta + tono. */
export const PAYMENT_STATUS: Record<PaymentStatus, StatusMeta> = {
  pendiente: { label: "Pendiente", tone: "warning" },
  confirmado: { label: "Confirmado", tone: "success" },
  rechazado: { label: "Rechazado", tone: "destructive" },
};

/** Método de pago → etiqueta es-MX. */
export const PAYMENT_METHOD_LABEL: Record<PaymentMethod, string> = {
  transferencia: "Transferencia",
  efectivo: "Efectivo",
  tarjeta: "Tarjeta",
  link: "Link de pago",
  otro: "Otro",
};
