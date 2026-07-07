"use client";

// ============================================================
// clinicOS — expediente 360° del lead/paciente desde el CRM.
//
// Al hacer click en una tarjeta del tablero se abre ESTA vista (no el
// formulario de edición): qué etapa lleva, cómo lo calificó el agente,
// sus citas y anticipos, qué ha pagado y qué debe, y su expediente
// clínico ligero (migración 041). El formulario clásico queda a un
// click en "Editar deal".
//
// Lecturas directas con el cliente del navegador: appointments,
// payments y patient_records tienen RLS de lectura para miembros de la
// cuenta (migraciones 031/041), así que no hace falta una API route.
// ============================================================

import { useEffect, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import type { Deal, PipelineStage, Tag } from "@/types";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import {
  CalendarDays,
  ClipboardList,
  CreditCard,
  Loader2,
  MessageSquare,
  Pencil,
  Phone,
  Stethoscope,
} from "lucide-react";
import { formatCurrency } from "@/lib/currency";

interface AppointmentRow {
  id: string;
  appointment_type: string;
  status: string;
  deposit_status: string;
  deposit_amount: number | null;
  starts_at: string;
  notes: string | null;
}

interface PaymentRow {
  id: string;
  amount: number;
  currency: string;
  method: string;
  status: string;
  concept: string | null;
  created_at: string;
}

interface PatientRecordRow {
  id: string;
  category: string;
  content: string;
  source: string;
  created_at: string;
}

interface LeadDetailProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  deal: Deal | null;
  stage: PipelineStage | null;
  /** Abre el formulario clásico de edición del deal. */
  onEdit: (deal: Deal) => void;
}

const APPT_STATUS_LABEL: Record<string, string> = {
  pendiente: "Pendiente de confirmar",
  confirmada: "Confirmada",
  completada: "Completada",
  cancelada: "Cancelada",
  no_asistio: "No asistió",
};

const APPT_STATUS_CLASS: Record<string, string> = {
  pendiente: "bg-amber-500/15 text-amber-500",
  confirmada: "bg-emerald-500/15 text-emerald-500",
  completada: "bg-teal-500/15 text-teal-500",
  cancelada: "bg-red-500/15 text-red-400",
  no_asistio: "bg-red-500/15 text-red-400",
};

const APPT_TYPE_LABEL: Record<string, string> = {
  valoracion: "Valoración",
  valoracion_virtual: "Valoración virtual",
  seguimiento: "Seguimiento",
  procedimiento: "Procedimiento",
  otro: "Cita",
};

const PAYMENT_STATUS_LABEL: Record<string, string> = {
  pendiente: "En revisión",
  confirmado: "Confirmado",
  rechazado: "Rechazado",
};

const PAYMENT_STATUS_CLASS: Record<string, string> = {
  pendiente: "bg-amber-500/15 text-amber-500",
  confirmado: "bg-emerald-500/15 text-emerald-500",
  rechazado: "bg-red-500/15 text-red-400",
};

const PAYMENT_METHOD_LABEL: Record<string, string> = {
  transferencia: "Transferencia",
  efectivo: "Efectivo",
  tarjeta: "Tarjeta",
  link: "Link de pago",
  otro: "Otro",
};

const RECORD_CATEGORY_LABEL: Record<string, string> = {
  motivo_consulta: "Motivo de consulta",
  sintoma: "Síntoma",
  alergia: "Alergia",
  medicamento: "Medicamento",
  antecedente: "Antecedente",
  tratamiento_previo: "Tratamiento previo",
  nota: "Nota",
};

const LEAD_TAG_LABEL: Record<string, string> = {
  "lead:pregunton": "Preguntón",
  "lead:interesado": "Interesado",
  "lead:seguimiento_futuro": "Seguimiento futuro",
  "lead:spam": "Spam",
};

function formatDateTime(iso: string) {
  return new Date(iso).toLocaleString("es-MX", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("es-MX", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function SectionTitle({
  icon: Icon,
  children,
}: {
  icon: typeof CalendarDays;
  children: React.ReactNode;
}) {
  return (
    <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
      <Icon className="h-3.5 w-3.5" />
      {children}
    </h3>
  );
}

export function LeadDetail({
  open,
  onOpenChange,
  deal,
  stage,
  onEdit,
}: LeadDetailProps) {
  const supabase = createClient();

  const [loading, setLoading] = useState(false);
  const [tags, setTags] = useState<Tag[]>([]);
  const [appointments, setAppointments] = useState<AppointmentRow[]>([]);
  const [payments, setPayments] = useState<PaymentRow[]>([]);
  const [records, setRecords] = useState<PatientRecordRow[]>([]);
  // Reloj capturado al cargar los datos — el render debe ser puro.
  const [loadedAt, setLoadedAt] = useState(0);

  const contactId = deal?.contact_id ?? null;

  // Limpiar al cerrar/sin contacto es un sync legítimo con props — el
  // mismo patrón (y disable) que deal-form.tsx.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!open || !contactId) {
      setTags([]);
      setAppointments([]);
      setPayments([]);
      setRecords([]);
      return;
    }
    let cancelled = false;
    (async () => {
      setLoading(true);
      const [tagsRes, apptRes, payRes, recRes] = await Promise.all([
        supabase
          .from("contact_tags")
          .select("tags(*)")
          .eq("contact_id", contactId),
        supabase
          .from("appointments")
          .select(
            "id, appointment_type, status, deposit_status, deposit_amount, starts_at, notes",
          )
          .eq("contact_id", contactId)
          .order("starts_at", { ascending: false })
          .limit(10),
        supabase
          .from("payments")
          .select("id, amount, currency, method, status, concept, created_at")
          .eq("contact_id", contactId)
          .order("created_at", { ascending: false })
          .limit(10),
        supabase
          .from("patient_records")
          .select("id, category, content, source, created_at")
          .eq("contact_id", contactId)
          .eq("is_active", true)
          .order("created_at", { ascending: false })
          .limit(30),
      ]);
      if (cancelled) return;
      setTags(
        (tagsRes.data ?? [])
          .map((r) => {
            // Supabase tipa la relación embebida como array; en runtime
            // un to-one llega como objeto. Normaliza ambos.
            const raw = r.tags as Tag | Tag[] | null;
            return Array.isArray(raw) ? raw[0] : raw;
          })
          .filter((t): t is Tag => Boolean(t)),
      );
      setAppointments((apptRes.data ?? []) as AppointmentRow[]);
      setPayments((payRes.data ?? []) as PaymentRow[]);
      setRecords((recRes.data ?? []) as PatientRecordRow[]);
      setLoadedAt(Date.now());
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, contactId, supabase]);
  /* eslint-enable react-hooks/set-state-in-effect */

  if (!deal) return null;

  const contactLabel = deal.contact?.name || deal.contact?.phone || "Sin contacto";
  const leadTag = tags.find((t) => t.name.startsWith("lead:"));
  const otherTags = tags.filter((t) => !t.name.startsWith("lead:"));

  const nextAppointment = [...appointments]
    .filter(
      (a) =>
        (a.status === "pendiente" || a.status === "confirmada") &&
        new Date(a.starts_at).getTime() > loadedAt,
    )
    .sort(
      (a, b) => new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime(),
    )[0];

  const totalPagado = payments
    .filter((p) => p.status === "confirmado")
    .reduce((s, p) => s + Number(p.amount || 0), 0);
  const enRevision = payments.filter((p) => p.status === "pendiente");
  const enTratamiento = appointments.some(
    (a) =>
      a.appointment_type === "procedimiento" &&
      (a.status === "confirmada" || a.status === "completada"),
  );

  // Próximo pago: un anticipo pendiente de la próxima cita manda; si ya
  // hay comprobante en revisión, eso es lo que sigue (que el equipo lo
  // confirme), no un nuevo cobro.
  let proximoPago: string | null = null;
  if (enRevision.length > 0) {
    proximoPago = `${formatCurrency(Number(enRevision[0].amount), enRevision[0].currency || "MXN")} en revisión del equipo`;
  } else if (
    nextAppointment &&
    nextAppointment.deposit_status === "pendiente" &&
    nextAppointment.deposit_amount != null
  ) {
    proximoPago = `Anticipo de ${formatCurrency(Number(nextAppointment.deposit_amount), "MXN")} para asegurar su cita`;
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full border-border bg-popover p-0 text-popover-foreground sm:max-w-lg"
      >
        <div className="flex h-full flex-col">
          <SheetHeader className="border-b border-border/50 p-4">
            <SheetTitle className="text-popover-foreground">
              {contactLabel}
            </SheetTitle>
            <div className="flex flex-wrap items-center gap-1.5 pt-1">
              {stage && (
                <span
                  className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold"
                  style={{
                    backgroundColor: `${stage.color}26`,
                    color: stage.color,
                  }}
                >
                  {stage.name}
                </span>
              )}
              {leadTag && (
                <span className="inline-flex items-center rounded-full bg-sky-500/15 px-2 py-0.5 text-[11px] font-semibold text-sky-400">
                  {LEAD_TAG_LABEL[leadTag.name] ?? leadTag.name}
                </span>
              )}
              {enTratamiento && (
                <span className="inline-flex items-center rounded-full bg-teal-500/15 px-2 py-0.5 text-[11px] font-semibold text-teal-400">
                  En tratamiento
                </span>
              )}
              {otherTags.map((t) => (
                <span
                  key={t.id}
                  className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium"
                  style={{ backgroundColor: `${t.color}26`, color: t.color }}
                >
                  {t.name}
                </span>
              ))}
            </div>
            {deal.contact?.phone && (
              <p className="flex items-center gap-1.5 pt-1 text-xs text-muted-foreground">
                <Phone className="h-3 w-3" />
                {deal.contact.phone}
              </p>
            )}
          </SheetHeader>

          <div className="flex-1 space-y-5 overflow-y-auto p-4">
            {loading ? (
              <div className="flex items-center justify-center py-16">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : !contactId ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                El contacto de este deal fue eliminado; solo queda el
                historial del deal.
              </p>
            ) : (
              <>
                {/* Resumen */}
                <div className="grid grid-cols-2 gap-2">
                  <div className="rounded-lg border border-border bg-muted/40 p-3">
                    <p className="text-[11px] uppercase tracking-wider text-muted-foreground">
                      Próxima cita
                    </p>
                    <p className="mt-1 text-sm font-semibold text-foreground">
                      {nextAppointment
                        ? formatDateTime(nextAppointment.starts_at)
                        : "Sin cita"}
                    </p>
                    {nextAppointment && (
                      <span
                        className={`mt-1 inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold ${APPT_STATUS_CLASS[nextAppointment.status] ?? "bg-muted text-muted-foreground"}`}
                      >
                        {APPT_STATUS_LABEL[nextAppointment.status] ??
                          nextAppointment.status}
                      </span>
                    )}
                  </div>
                  <div className="rounded-lg border border-border bg-muted/40 p-3">
                    <p className="text-[11px] uppercase tracking-wider text-muted-foreground">
                      Total pagado
                    </p>
                    <p className="mt-1 text-sm font-semibold text-primary">
                      {formatCurrency(totalPagado, "MXN")}
                    </p>
                    {proximoPago && (
                      <p className="mt-1 text-[11px] leading-snug text-amber-500">
                        {proximoPago}
                      </p>
                    )}
                  </div>
                </div>

                {/* Citas */}
                <section className="space-y-2">
                  <SectionTitle icon={CalendarDays}>Citas</SectionTitle>
                  {appointments.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      Sin citas registradas.
                    </p>
                  ) : (
                    <ul className="space-y-1.5">
                      {appointments.map((a) => (
                        <li
                          key={a.id}
                          className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-xs font-medium text-foreground">
                              {formatDateTime(a.starts_at)}
                            </span>
                            <span
                              className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${APPT_STATUS_CLASS[a.status] ?? "bg-muted text-muted-foreground"}`}
                            >
                              {APPT_STATUS_LABEL[a.status] ?? a.status}
                            </span>
                          </div>
                          <div className="mt-0.5 flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                            <span>
                              {APPT_TYPE_LABEL[a.appointment_type] ??
                                a.appointment_type}
                            </span>
                            <span>
                              {a.deposit_status === "pagado"
                                ? "Anticipo pagado"
                                : a.deposit_status === "pendiente"
                                  ? `Anticipo pendiente${a.deposit_amount != null ? ` · ${formatCurrency(Number(a.deposit_amount), "MXN")}` : ""}`
                                  : "Sin anticipo"}
                            </span>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>

                {/* Pagos */}
                <section className="space-y-2">
                  <SectionTitle icon={CreditCard}>
                    Pagos y anticipos
                  </SectionTitle>
                  {payments.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      Sin pagos registrados.
                    </p>
                  ) : (
                    <ul className="space-y-1.5">
                      {payments.map((p) => (
                        <li
                          key={p.id}
                          className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-xs font-semibold text-foreground">
                              {formatCurrency(Number(p.amount), p.currency || "MXN")}
                            </span>
                            <span
                              className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${PAYMENT_STATUS_CLASS[p.status] ?? "bg-muted text-muted-foreground"}`}
                            >
                              {PAYMENT_STATUS_LABEL[p.status] ?? p.status}
                            </span>
                          </div>
                          <div className="mt-0.5 flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                            <span>
                              {p.concept || "Pago"} ·{" "}
                              {PAYMENT_METHOD_LABEL[p.method] ?? p.method}
                            </span>
                            <span>{formatDate(p.created_at)}</span>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>

                {/* Expediente clínico */}
                <section className="space-y-2">
                  <SectionTitle icon={Stethoscope}>
                    Expediente clínico
                  </SectionTitle>
                  {records.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      Aún sin datos clínicos. El agente los registra en
                      automático cuando el paciente los cuenta por WhatsApp.
                    </p>
                  ) : (
                    <ul className="space-y-1.5">
                      {records.map((r) => (
                        <li
                          key={r.id}
                          className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary">
                              {RECORD_CATEGORY_LABEL[r.category] ?? r.category}
                            </span>
                            <span className="text-[10px] text-muted-foreground">
                              {formatDate(r.created_at)}
                            </span>
                          </div>
                          <p className="mt-1 text-xs leading-snug text-foreground">
                            {r.content}
                          </p>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>

                {/* Deal */}
                <section className="space-y-2">
                  <SectionTitle icon={ClipboardList}>Deal</SectionTitle>
                  <div className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-xs">
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground">Valor</span>
                      <span className="font-semibold text-primary">
                        {formatCurrency(deal.value, deal.currency)}
                      </span>
                    </div>
                    {deal.notes && (
                      <p className="mt-2 whitespace-pre-wrap leading-snug text-foreground">
                        {deal.notes}
                      </p>
                    )}
                  </div>
                </section>
              </>
            )}
          </div>

          <div className="border-t border-border/50 bg-popover/80 p-4">
            <div className="flex gap-2">
              {deal.conversation_id && (
                <Link
                  href={`/inbox?c=${deal.conversation_id}`}
                  className="inline-flex flex-1 items-center justify-center rounded-lg border border-border bg-transparent px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted"
                >
                  <MessageSquare className="mr-1 h-4 w-4" />
                  Abrir chat
                </Link>
              )}
              <Button
                onClick={() => onEdit(deal)}
                className="flex-1 bg-primary text-primary-foreground hover:bg-primary/90"
              >
                <Pencil className="mr-1 h-4 w-4" />
                Editar deal
              </Button>
            </div>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
