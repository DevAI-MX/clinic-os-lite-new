/**
 * Tipos del dominio clínico — espejo 1:1 de
 * `supabase/migrations/031_clinic_scheduling.sql`.
 *
 * Convenciones:
 *  - Timestamps (`timestamptz`) viajan como string ISO (igual que el
 *    resto de la app — ver `Contact.created_at` en src/types).
 *  - `numeric(12,2)` llega como `number` vía PostgREST.
 *  - Columnas NULLables se tipan `| null` (no opcionales) para que un
 *    destructure olvidado truene en compilación, no en runtime.
 */

// ------------------------------------------------------------
// Uniones de estado (los CHECK constraints de la migración)
// ------------------------------------------------------------

export type AppointmentType =
  | "valoracion"
  | "valoracion_virtual"
  | "seguimiento"
  | "procedimiento"
  | "otro";

export type AppointmentStatus =
  | "pendiente"
  | "confirmada"
  | "completada"
  | "cancelada"
  | "no_asistio";

export type DepositStatus = "no_aplica" | "pendiente" | "pagado";

export type PaymentMethod =
  | "transferencia"
  | "efectivo"
  | "tarjeta"
  | "link"
  | "otro";

export type PaymentStatus = "pendiente" | "confirmado" | "rechazado";

/** Moneda por defecto del dominio clínico (DEFAULT 'MXN' en la migración). */
export const CLINIC_CURRENCY = "MXN";

// ------------------------------------------------------------
// Filas
// ------------------------------------------------------------

/** Catálogo de procedimientos de la clínica. */
export interface Procedure {
  id: string;
  account_id: string;
  name: string;
  description: string | null;
  category: string | null;
  price_min: number | null;
  price_max: number | null;
  currency: string;
  /** NULL = el procedimiento no requiere anticipo. */
  deposit_amount: number | null;
  duration_minutes: number;
  /** Directrices de venta que consume el agente de atención. */
  sales_notes: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

/** Bloque de horario semanal (0 = domingo … 6 = sábado). */
export interface ClinicHour {
  id: string;
  account_id: string;
  weekday: number;
  /** `time` de Postgres — "HH:MM:SS". */
  opens_at: string;
  closes_at: string;
  slot_minutes: number;
}

/** Bloqueo puntual de agenda (cirugías, vacaciones, comidas). */
export interface ScheduleBlock {
  id: string;
  account_id: string;
  starts_at: string;
  ends_at: string;
  reason: string | null;
  created_by: string | null;
  created_at: string;
}

export interface Appointment {
  id: string;
  account_id: string;
  contact_id: string;
  /** Conversación de WhatsApp que originó la cita, si aplica. */
  conversation_id: string | null;
  procedure_id: string | null;
  appointment_type: AppointmentType;
  status: AppointmentStatus;
  deposit_status: DepositStatus;
  /** Snapshot del anticipo requerido al momento de agendar. */
  deposit_amount: number | null;
  starts_at: string;
  ends_at: string;
  notes: string | null;
  /** NULL = creada por el agente IA (service-role). */
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface Payment {
  id: string;
  account_id: string;
  contact_id: string;
  appointment_id: string | null;
  amount: number;
  currency: string;
  method: PaymentMethod;
  status: PaymentStatus;
  concept: string | null;
  receipt_url: string | null;
  confirmed_by: string | null;
  confirmed_at: string | null;
  created_at: string;
  updated_at: string;
}

// ------------------------------------------------------------
// Formas hidratadas (embeds de PostgREST que usa el calendario)
// ------------------------------------------------------------

/** Subconjunto del contacto que embebe la consulta del calendario. */
export interface AppointmentContact {
  id: string;
  name: string | null;
  phone: string;
}

/** Subconjunto del procedimiento que embebe la consulta del calendario. */
export interface AppointmentProcedure {
  id: string;
  name: string;
  price_min: number | null;
  price_max: number | null;
  currency: string;
  deposit_amount: number | null;
  duration_minutes: number;
}

/** Cita con contacto y procedimiento embebidos (vista de agenda). */
export interface AppointmentWithRelations extends Appointment {
  contact: AppointmentContact | null;
  procedure: AppointmentProcedure | null;
}
