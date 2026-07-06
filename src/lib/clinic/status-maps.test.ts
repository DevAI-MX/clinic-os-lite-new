import { describe, expect, it } from "vitest";
import {
  APPOINTMENT_STATUS,
  APPOINTMENT_TYPE_LABEL,
  DEPOSIT_STATUS,
  PAYMENT_METHOD_LABEL,
  PAYMENT_STATUS,
  type StatusMeta,
  type Tone,
} from "./status-maps";
import type {
  AppointmentStatus,
  AppointmentType,
  DepositStatus,
  PaymentMethod,
  PaymentStatus,
} from "./types";

const TONES: Tone[] = ["success", "warning", "destructive", "primary", "muted"];

function expectCompleteMeta(map: Record<string, StatusMeta>, keys: string[]) {
  expect(Object.keys(map).sort()).toEqual([...keys].sort());
  for (const key of keys) {
    const meta = map[key];
    expect(meta.label.length, `label vacío para ${key}`).toBeGreaterThan(0);
    expect(TONES, `tone inválido para ${key}`).toContain(meta.tone);
  }
}

describe("status-maps", () => {
  it("APPOINTMENT_STATUS cubre los 5 estados del CHECK de la migración", () => {
    const keys: AppointmentStatus[] = [
      "pendiente",
      "confirmada",
      "completada",
      "cancelada",
      "no_asistio",
    ];
    expectCompleteMeta(APPOINTMENT_STATUS, keys);
  });

  it("asigna los tonos acordados del calendario", () => {
    expect(APPOINTMENT_STATUS.pendiente.tone).toBe("warning");
    expect(APPOINTMENT_STATUS.confirmada.tone).toBe("primary");
    expect(APPOINTMENT_STATUS.completada.tone).toBe("success");
  });

  it("DEPOSIT_STATUS cubre los 3 estados y marca pendiente como warning", () => {
    const keys: DepositStatus[] = ["no_aplica", "pendiente", "pagado"];
    expectCompleteMeta(DEPOSIT_STATUS, keys);
    expect(DEPOSIT_STATUS.pendiente.tone).toBe("warning");
    expect(DEPOSIT_STATUS.pagado.tone).toBe("success");
  });

  it("PAYMENT_STATUS cubre los 3 estados del CHECK", () => {
    const keys: PaymentStatus[] = ["pendiente", "confirmado", "rechazado"];
    expectCompleteMeta(PAYMENT_STATUS, keys);
    expect(PAYMENT_STATUS.confirmado.tone).toBe("success");
    expect(PAYMENT_STATUS.rechazado.tone).toBe("destructive");
  });

  it("APPOINTMENT_TYPE_LABEL etiqueta los 5 tipos en es-MX", () => {
    const keys: AppointmentType[] = [
      "valoracion",
      "valoracion_virtual",
      "seguimiento",
      "procedimiento",
      "otro",
    ];
    expect(Object.keys(APPOINTMENT_TYPE_LABEL).sort()).toEqual([...keys].sort());
    expect(APPOINTMENT_TYPE_LABEL.valoracion).toBe("Valoración");
    expect(APPOINTMENT_TYPE_LABEL.valoracion_virtual).toBe("Valoración virtual");
  });

  it("PAYMENT_METHOD_LABEL etiqueta los 5 métodos", () => {
    const keys: PaymentMethod[] = [
      "transferencia",
      "efectivo",
      "tarjeta",
      "link",
      "otro",
    ];
    expect(Object.keys(PAYMENT_METHOD_LABEL).sort()).toEqual([...keys].sort());
  });
});
