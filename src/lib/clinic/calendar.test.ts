import { describe, expect, it } from "vitest";
import {
  addDays,
  formatTime,
  GRID_MINUTES,
  gridPosition,
  hourLabels,
  isSameDay,
  layoutOverlaps,
  MIN_BLOCK_MINUTES,
  mondayOf,
  nowLinePct,
  segmentForDay,
  startOfDay,
  timeSlotOptions,
  toDateInputValue,
  weekDays,
  type OverlapInput,
} from "./calendar";

/** Atajo: Date local del 2026-07-06 (lunes) a la hora dada. */
function d(day: number, hour: number, minute = 0): Date {
  return new Date(2026, 6, day, hour, minute);
}

function ev(id: string, start: Date, end: Date): OverlapInput {
  return { id, start: start.getTime(), end: end.getTime() };
}

describe("fechas", () => {
  it("startOfDay regresa la medianoche local", () => {
    const s = startOfDay(d(6, 15, 42));
    expect([s.getHours(), s.getMinutes(), s.getDate()]).toEqual([0, 0, 6]);
  });

  it("addDays cruza fin de mes", () => {
    const r = addDays(new Date(2026, 6, 31, 10), 2);
    expect([r.getMonth(), r.getDate(), r.getHours()]).toEqual([7, 2, 10]);
  });

  it("isSameDay distingue medianoche exacta", () => {
    expect(isSameDay(d(6, 0), d(6, 23, 59))).toBe(true);
    expect(isSameDay(d(6, 23, 59), d(7, 0))).toBe(false);
  });

  it("mondayOf: lunes se queda, domingo retrocede 6 días", () => {
    // 2026-07-06 es lunes; 2026-07-12 es domingo.
    expect(mondayOf(d(6, 12)).getDate()).toBe(6);
    expect(mondayOf(d(12, 12)).getDate()).toBe(6);
    expect(mondayOf(d(9, 0)).getDate()).toBe(6); // jueves
  });

  it("weekDays regresa lun→dom", () => {
    const days = weekDays(d(9, 10));
    expect(days).toHaveLength(7);
    expect(days[0].getDay()).toBe(1); // lunes
    expect(days[6].getDay()).toBe(0); // domingo
    expect(days.map((x) => x.getDate())).toEqual([6, 7, 8, 9, 10, 11, 12]);
  });

  it("toDateInputValue formatea yyyy-mm-dd local", () => {
    expect(toDateInputValue(new Date(2026, 0, 5))).toBe("2026-01-05");
  });
});

describe("segmentForDay", () => {
  it("evento dentro del día pasa intacto", () => {
    const seg = segmentForDay(d(6, 10), d(6, 11), d(6, 0))!;
    expect(seg.start.getHours()).toBe(10);
    expect(seg.end.getHours()).toBe(11);
    expect(seg.clippedStart).toBe(false);
    expect(seg.clippedEnd).toBe(false);
  });

  it("bloqueo multi-día se recorta por ambos lados", () => {
    // Vacaciones: del 5 a las 08:00 al 8 a las 18:00, visto el día 6.
    const seg = segmentForDay(d(5, 8), d(8, 18), d(6, 12))!;
    expect(seg.start.getHours()).toBe(0);
    expect(isSameDay(seg.end, d(7, 0))).toBe(true);
    expect(seg.clippedStart).toBe(true);
    expect(seg.clippedEnd).toBe(true);
  });

  it("regresa null si el evento no toca el día", () => {
    expect(segmentForDay(d(6, 10), d(6, 11), d(7, 0))).toBeNull();
    // end === medianoche del día consultado no cuenta (intervalo semiabierto)
    expect(segmentForDay(d(5, 22), d(6, 0), d(6, 0))).toBeNull();
  });
});

describe("gridPosition (ventana 07:00–21:00)", () => {
  it("07:00–08:00 arranca en 0% y mide 1/14 de la rejilla", () => {
    const pos = gridPosition(d(6, 7), d(6, 8))!;
    expect(pos.topPct).toBeCloseTo(0);
    expect(pos.heightPct).toBeCloseTo((60 / GRID_MINUTES) * 100);
  });

  it("14:00–15:30 se posiciona a mitad de rejilla", () => {
    const pos = gridPosition(d(6, 14), d(6, 15, 30))!;
    expect(pos.topPct).toBeCloseTo(50); // 7h de 14h
    expect(pos.heightPct).toBeCloseTo((90 / GRID_MINUTES) * 100);
  });

  it("recorta lo que sobresale de la ventana", () => {
    const pos = gridPosition(d(6, 6), d(6, 8))!; // empieza antes de las 07:00
    expect(pos.topPct).toBeCloseTo(0);
    expect(pos.heightPct).toBeCloseTo((60 / GRID_MINUTES) * 100);
  });

  it("null si cae completamente fuera", () => {
    expect(gridPosition(d(6, 5), d(6, 6, 30))).toBeNull();
    expect(gridPosition(d(6, 21), d(6, 22))).toBeNull();
  });

  it("garantiza altura mínima para citas cortitas", () => {
    const pos = gridPosition(d(6, 10), d(6, 10, 5))!;
    expect(pos.heightPct).toBeCloseTo((MIN_BLOCK_MINUTES / GRID_MINUTES) * 100);
  });
});

describe("nowLinePct", () => {
  it("dentro de la ventana regresa el % correcto", () => {
    expect(nowLinePct(d(6, 14))).toBeCloseTo(50);
    expect(nowLinePct(d(6, 7))).toBeCloseTo(0);
  });
  it("fuera de la ventana regresa null", () => {
    expect(nowLinePct(d(6, 6, 59))).toBeNull();
    expect(nowLinePct(d(6, 22))).toBeNull();
  });
});

describe("layoutOverlaps", () => {
  it("sin choques: todos columna 0 de 1", () => {
    const layout = layoutOverlaps([
      ev("a", d(6, 9), d(6, 10)),
      ev("b", d(6, 10), d(6, 11)), // tocarse en la frontera NO es choque
      ev("c", d(6, 15), d(6, 16)),
    ]);
    for (const id of ["a", "b", "c"]) {
      expect(layout.get(id)).toEqual({ column: 0, columns: 1 });
    }
  });

  it("dos citas que chocan quedan lado a lado", () => {
    const layout = layoutOverlaps([
      ev("a", d(6, 9), d(6, 10, 30)),
      ev("b", d(6, 10), d(6, 11)),
    ]);
    expect(layout.get("a")).toEqual({ column: 0, columns: 2 });
    expect(layout.get("b")).toEqual({ column: 1, columns: 2 });
  });

  it("cadena transitiva comparte grupo aunque los extremos no choquen", () => {
    // a(9–11) choca con b(10–12); b choca con c(11:30–13); a y c NO chocan,
    // pero forman un solo grupo → todos reportan columns=2 y c reusa la col 0.
    const layout = layoutOverlaps([
      ev("a", d(6, 9), d(6, 11)),
      ev("b", d(6, 10), d(6, 12)),
      ev("c", d(6, 11, 30), d(6, 13)),
    ]);
    expect(layout.get("a")).toEqual({ column: 0, columns: 2 });
    expect(layout.get("b")).toEqual({ column: 1, columns: 2 });
    expect(layout.get("c")).toEqual({ column: 0, columns: 2 });
  });

  it("triple choque simultáneo reparte 3 columnas", () => {
    const layout = layoutOverlaps([
      ev("a", d(6, 9), d(6, 10)),
      ev("b", d(6, 9), d(6, 10)),
      ev("c", d(6, 9, 30), d(6, 10, 30)),
    ]);
    const cols = ["a", "b", "c"].map((id) => layout.get(id)!);
    expect(new Set(cols.map((s) => s.column))).toEqual(new Set([0, 1, 2]));
    expect(cols.every((s) => s.columns === 3)).toBe(true);
  });

  it("un grupo cerrado no infla al siguiente", () => {
    const layout = layoutOverlaps([
      ev("a", d(6, 9), d(6, 10)),
      ev("b", d(6, 9), d(6, 10)),
      ev("c", d(6, 12), d(6, 13)), // grupo nuevo
    ]);
    expect(layout.get("c")).toEqual({ column: 0, columns: 1 });
  });

  it("es estable con el orden de entrada", () => {
    const events = [
      ev("b", d(6, 10), d(6, 11)),
      ev("a", d(6, 9), d(6, 10, 30)),
    ];
    const layout = layoutOverlaps(events);
    expect(layout.get("a")!.column).toBe(0);
    expect(layout.get("b")!.column).toBe(1);
  });

  it("lista vacía regresa mapa vacío", () => {
    expect(layoutOverlaps([]).size).toBe(0);
  });
});

describe("rejilla y slots", () => {
  it("hourLabels cubre 07:00–20:00 (14 filas)", () => {
    const labels = hourLabels();
    expect(labels).toHaveLength(14);
    expect(labels[0]).toBe("07:00");
    expect(labels.at(-1)).toBe("20:00");
  });

  it("timeSlotOptions cada 30 min dentro de la ventana", () => {
    const slots = timeSlotOptions(30);
    expect(slots[0]).toBe("07:00");
    expect(slots[1]).toBe("07:30");
    expect(slots.at(-1)).toBe("20:30");
    expect(slots).toHaveLength(28);
  });

  it("formatTime es 24h con cero a la izquierda", () => {
    expect(formatTime(d(6, 9, 5))).toBe("09:05");
    expect(formatTime(d(6, 14, 30))).toBe("14:30");
  });
});
