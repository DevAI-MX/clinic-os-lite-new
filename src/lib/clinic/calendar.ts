/**
 * Lógica pura del calendario — fechas, rejilla horaria y layout de
 * solapamientos. Sin React, sin Supabase, sin I/O: todo es testeable
 * con vitest (ver calendar.test.ts).
 *
 * Convención horaria: todas las funciones operan en hora LOCAL del
 * navegador (la clínica agenda en su propia zona; los timestamptz de
 * la DB se convierten al construir `Date`).
 */

// ------------------------------------------------------------
// Ventana visible de la rejilla (07:00–21:00)
// ------------------------------------------------------------

export const GRID_START_HOUR = 7;
export const GRID_END_HOUR = 21;
/** Minutos visibles en la rejilla. */
export const GRID_MINUTES = (GRID_END_HOUR - GRID_START_HOUR) * 60;

// ------------------------------------------------------------
// Fechas
// ------------------------------------------------------------

/** Medianoche local del día de `d`. */
export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** `d` + `n` días (respeta DST — usa aritmética de calendario). */
export function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds());
}

export function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** Lunes (00:00) de la semana de `d`. La semana clínica corre lun→dom. */
export function mondayOf(d: Date): Date {
  const day = startOfDay(d);
  // getDay(): 0 = domingo … 6 = sábado. Distancia hacia atrás al lunes.
  const back = (day.getDay() + 6) % 7;
  return addDays(day, -back);
}

/** Los 7 días (lun→dom, medianoche local) de la semana de `d`. */
export function weekDays(d: Date): Date[] {
  const monday = mondayOf(d);
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
}

/** Minutos transcurridos desde la medianoche local de `d`. */
export function minutesIntoDay(d: Date): number {
  return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
}

// ------------------------------------------------------------
// Recorte de eventos a un día (los bloqueos pueden abarcar varios)
// ------------------------------------------------------------

export interface DaySegment {
  /** Inicio del segmento, ya recortado al día. */
  start: Date;
  /** Fin del segmento, ya recortado al día. */
  end: Date;
  /** true si el evento empezó antes de este día. */
  clippedStart: boolean;
  /** true si el evento termina después de este día. */
  clippedEnd: boolean;
}

/**
 * Intersección de [starts, ends) con el día de `day` (medianoche →
 * medianoche siguiente). `null` si no tocan ese día.
 */
export function segmentForDay(
  starts: Date,
  ends: Date,
  day: Date,
): DaySegment | null {
  const dayStart = startOfDay(day);
  const dayEnd = addDays(dayStart, 1);
  if (ends <= dayStart || starts >= dayEnd) return null;
  const start = starts < dayStart ? dayStart : starts;
  const end = ends > dayEnd ? dayEnd : ends;
  if (end <= start) return null;
  return {
    start,
    end,
    clippedStart: starts < dayStart,
    clippedEnd: ends > dayEnd,
  };
}

// ------------------------------------------------------------
// Posición vertical dentro de la rejilla 07:00–21:00
// ------------------------------------------------------------

export interface GridPosition {
  /** Distancia desde arriba, en % de la altura total de la rejilla. */
  topPct: number;
  /** Altura, en % de la altura total de la rejilla. */
  heightPct: number;
}

/** Altura mínima visual de un bloque, en minutos de rejilla. */
export const MIN_BLOCK_MINUTES = 20;

/**
 * Posición vertical de un intervalo (mismo día) dentro de la ventana
 * 07:00–21:00. Recorta lo que sobresale; `null` si cae completamente
 * fuera de la ventana. Garantiza una altura mínima legible.
 */
export function gridPosition(start: Date, end: Date): GridPosition | null {
  const gridStart = GRID_START_HOUR * 60;
  const gridEnd = GRID_END_HOUR * 60;
  const from = Math.max(minutesIntoDay(start), gridStart);
  const to = Math.min(minutesIntoDay(end), gridEnd);
  if (to <= gridStart || from >= gridEnd) return null;

  const clampedFrom = Math.min(from, gridEnd - MIN_BLOCK_MINUTES);
  const height = Math.max(to - clampedFrom, MIN_BLOCK_MINUTES);
  return {
    topPct: ((clampedFrom - gridStart) / GRID_MINUTES) * 100,
    heightPct: (height / GRID_MINUTES) * 100,
  };
}

/** Posición (en %) de la línea de "ahora"; `null` fuera de 07:00–21:00. */
export function nowLinePct(now: Date): number | null {
  const minutes = minutesIntoDay(now);
  const gridStart = GRID_START_HOUR * 60;
  const gridEnd = GRID_END_HOUR * 60;
  if (minutes < gridStart || minutes > gridEnd) return null;
  return ((minutes - gridStart) / GRID_MINUTES) * 100;
}

// ------------------------------------------------------------
// Layout de solapamientos (citas lado a lado cuando chocan)
// ------------------------------------------------------------

export interface OverlapInput {
  id: string;
  /** Inicio en ms (Date.getTime()). */
  start: number;
  /** Fin en ms. */
  end: number;
}

export interface OverlapSlot {
  /** Columna asignada dentro de su grupo (0-based). */
  column: number;
  /** Total de columnas del grupo — ancho = 1/columns. */
  columns: number;
}

/**
 * Asigna columnas lado a lado a eventos que chocan en el mismo día.
 *
 * Algoritmo clásico de agenda: se agrupan eventos que se solapan
 * TRANSITIVAMENTE (A–B y B–C ⇒ {A,B,C} comparten grupo) y dentro del
 * grupo cada evento toma la primera columna libre (greedy por hora de
 * inicio). Todos los eventos del grupo reportan el mismo `columns`
 * para que sus anchos sumen 100%.
 *
 * Tocarse en la frontera (end === start) NO es solapamiento.
 */
export function layoutOverlaps(
  events: OverlapInput[],
): Map<string, OverlapSlot> {
  const result = new Map<string, OverlapSlot>();
  const sorted = [...events].sort(
    (a, b) => a.start - b.start || b.end - a.end || a.id.localeCompare(b.id),
  );

  // Estado del grupo (cluster) actual.
  let clusterIds: string[] = [];
  let columnEnds: number[] = []; // fin del último evento por columna
  let clusterEnd = -Infinity;

  const flush = () => {
    for (const id of clusterIds) {
      result.get(id)!.columns = columnEnds.length;
    }
    clusterIds = [];
    columnEnds = [];
    clusterEnd = -Infinity;
  };

  for (const ev of sorted) {
    if (clusterIds.length > 0 && ev.start >= clusterEnd) flush();

    // Primera columna cuyo último evento ya terminó.
    let column = columnEnds.findIndex((end) => end <= ev.start);
    if (column === -1) {
      column = columnEnds.length;
      columnEnds.push(ev.end);
    } else {
      columnEnds[column] = ev.end;
    }

    clusterIds.push(ev.id);
    clusterEnd = Math.max(clusterEnd, ev.end);
    result.set(ev.id, { column, columns: 1 }); // columns se corrige en flush()
  }
  if (clusterIds.length > 0) flush();

  return result;
}

// ------------------------------------------------------------
// Etiquetas de la rejilla y slots de tiempo
// ------------------------------------------------------------

/** "07:00" … "20:00" — una etiqueta por fila de hora de la rejilla. */
export function hourLabels(): string[] {
  const labels: string[] = [];
  for (let h = GRID_START_HOUR; h < GRID_END_HOUR; h++) {
    labels.push(`${String(h).padStart(2, "0")}:00`);
  }
  return labels;
}

/**
 * Opciones "HH:MM" cada `stepMinutes` dentro de la ventana de la
 * rejilla — para selects de hora en formularios.
 */
export function timeSlotOptions(stepMinutes = 30): string[] {
  const slots: string[] = [];
  for (
    let m = GRID_START_HOUR * 60;
    m < GRID_END_HOUR * 60;
    m += stepMinutes
  ) {
    const h = Math.floor(m / 60);
    const min = m % 60;
    slots.push(
      `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`,
    );
  }
  return slots;
}

// ------------------------------------------------------------
// Formato es-MX (hora 24h para la agenda, como el legacy)
// ------------------------------------------------------------

/** "09:30" / "14:00" — hora local, formato 24h. */
export function formatTime(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(
    d.getMinutes(),
  ).padStart(2, "0")}`;
}

/** "lun 8 jun" — encabezado de columna del calendario. */
export function formatDayShort(d: Date): string {
  return d
    .toLocaleDateString("es-MX", {
      weekday: "short",
      day: "numeric",
      month: "short",
    })
    .replace(/\.,?/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** "8 jun – 14 jun 2026" — rango del toolbar en vista semana. */
export function formatWeekRange(anchor: Date): string {
  const days = weekDays(anchor);
  const first = days[0];
  const last = days[6];
  const fmt = (d: Date) =>
    d
      .toLocaleDateString("es-MX", { day: "numeric", month: "short" })
      .replace(/\./g, "");
  return `${fmt(first)} – ${fmt(last)} ${last.getFullYear()}`;
}

/** "lunes 8 de junio de 2026" — encabezado del toolbar en vista día. */
export function formatDayLong(d: Date): string {
  return d.toLocaleDateString("es-MX", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

/** "2026-07-06" — valor para `<input type="date">` en hora local. */
export function toDateInputValue(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}
