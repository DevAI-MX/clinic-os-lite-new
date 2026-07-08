import { describe, it, expect } from 'vitest'
import { buildPatientStateLines, buildReceptionFlowLines } from './state'

// Fake mínimo: soporta el subconjunto que usa buildPatientStateLines
// (select/eq/in/gt/eq/order/limit/maybeSingle).
type Row = Record<string, unknown>

function fakeDb(seed: Record<string, Row[]>) {
  return {
    from(table: string) {
      const filters: ((r: Row) => boolean)[] = []
      let order: { col: string; asc: boolean } | null = null
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chain: any = {
        select: () => chain,
        eq: (c: string, v: unknown) => {
          filters.push((r) => r[c] === v)
          return chain
        },
        in: (c: string, vs: unknown[]) => {
          filters.push((r) => vs.includes(r[c]))
          return chain
        },
        gt: (c: string, v: string) => {
          filters.push((r) => String(r[c]) > v)
          return chain
        },
        order: (col: string, opts?: { ascending?: boolean }) => {
          order = { col, asc: opts?.ascending !== false }
          return chain
        },
        limit: () => chain,
        maybeSingle: () => {
          let rows = (seed[table] ?? []).filter((r) => filters.every((f) => f(r)))
          if (order) {
            const { col, asc } = order
            rows = [...rows].sort(
              (a, b) => (String(a[col]) > String(b[col]) ? 1 : -1) * (asc ? 1 : -1),
            )
          }
          return Promise.resolve({ data: rows[0] ?? null, error: null })
        },
      }
      return chain
    },
  }
}

const BASE = {
  accountId: 'acc-1',
  contactId: 'contact-1',
  timezone: 'America/Mexico_City',
  now: new Date('2026-07-08T16:00:00Z'),
}

describe('buildPatientStateLines', () => {
  it('sin cita: le dice al modelo que NO hay nada agendado (anti-contradicción)', async () => {
    const db = fakeDb({ appointments: [], payments: [] })
    const lines = await buildPatientStateLines({ db: db as never, ...BASE })
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('NO tiene ninguna cita apartada')
    expect(lines[0]).toContain('agendar_cita')
  })

  it('con cita apartada: reporta fecha, estado y anticipo pendiente', async () => {
    const db = fakeDb({
      appointments: [
        {
          account_id: 'acc-1',
          contact_id: 'contact-1',
          status: 'pendiente',
          deposit_status: 'pendiente',
          deposit_amount: '350',
          starts_at: '2026-07-08T22:30:00Z', // 16:30 CDMX
          ends_at: '2026-07-08T23:30:00Z',
        },
      ],
      payments: [],
    })
    const lines = await buildPatientStateLines({ db: db as never, ...BASE })
    expect(lines[0]).toContain('Cita apartada')
    expect(lines[0]).toContain('pendiente de confirmar')
    expect(lines[0]).toContain('350')
  })

  it('con anticipo en revisión: pide no volver a cobrar', async () => {
    const db = fakeDb({
      appointments: [],
      payments: [
        {
          account_id: 'acc-1',
          contact_id: 'contact-1',
          status: 'pendiente',
          amount: '350',
          currency: 'MXN',
          created_at: '2026-07-08T15:00:00Z',
        },
      ],
    })
    const lines = await buildPatientStateLines({ db: db as never, ...BASE })
    expect(lines.some((l) => l.includes('EN REVISIÓN'))).toBe(true)
    expect(lines.some((l) => l.includes('no le vuelvas a pedir'))).toBe(true)
  })

  it('las citas de OTRO contacto no cuentan (aislamiento)', async () => {
    const db = fakeDb({
      appointments: [
        {
          account_id: 'acc-1',
          contact_id: 'otro',
          status: 'pendiente',
          deposit_status: 'pendiente',
          deposit_amount: '350',
          starts_at: '2026-07-08T22:30:00Z',
          ends_at: '2026-07-08T23:30:00Z',
        },
      ],
      payments: [],
    })
    const lines = await buildPatientStateLines({ db: db as never, ...BASE })
    expect(lines[0]).toContain('NO tiene ninguna cita apartada')
  })

  it('un error de BD degrada a [] (el agente corre igual, sin snapshot)', async () => {
    const broken = { from: () => { throw new Error('boom') } }
    const lines = await buildPatientStateLines({ db: broken as never, ...BASE })
    expect(lines).toEqual([])
  })
})

// ------------------------------------------------------------
// Checklist del flujo de recepción (formulario multi-step de Sofía):
// 5 pasos con estado REAL de BD. Solo marca hecho lo que la BD
// confirma; lo conversacional queda como instrucción, nunca como hecho.
// ------------------------------------------------------------

const APPT_PENDIENTE = {
  account_id: 'acc-1',
  contact_id: 'contact-1',
  status: 'pendiente',
  deposit_status: 'pendiente',
  deposit_amount: '350',
  procedure_id: 'proc-1',
  appointment_type: 'valoracion',
  starts_at: '2026-07-08T22:30:00Z',
  ends_at: '2026-07-08T23:30:00Z',
}

const PROCEDURES = [{ account_id: 'acc-1', id: 'proc-1', name: 'Valoración con el Dr.' }]

describe('buildReceptionFlowLines', () => {
  it('paciente sin cita: nada figura como hecho y el siguiente paso es cerrar horario', async () => {
    const db = fakeDb({ appointments: [], payments: [], procedures: [] })
    const lines = await buildReceptionFlowLines({
      db: db as never,
      ...BASE,
      contactName: 'Laura Medina',
    })
    expect(lines).toHaveLength(5)
    expect(lines[0]).toContain('sin confirmar en el sistema')
    expect(lines[1]).toContain('NO hay ninguna cita apartada')
    expect(lines[1]).toContain('agendar_cita')
    expect(lines[2]).toContain('Laura Medina')
    expect(lines[3]).toContain('DESPUÉS de apartar la cita')
    expect(lines[4]).toContain('elegir horario')
  })

  it('sin cita y sin nombre: el siguiente paso incluye capturar el nombre', async () => {
    const db = fakeDb({ appointments: [], payments: [], procedures: [] })
    const lines = await buildReceptionFlowLines({
      db: db as never,
      ...BASE,
      contactName: null,
    })
    expect(lines[2]).toContain('sin nombre registrado')
    expect(lines[4]).toContain('captura su nombre')
  })

  it('cita pendiente con anticipo pendiente: pasos 1-2 hechos, siguiente = comprobante', async () => {
    const db = fakeDb({
      appointments: [APPT_PENDIENTE],
      payments: [],
      procedures: PROCEDURES,
    })
    const lines = await buildReceptionFlowLines({
      db: db as never,
      ...BASE,
      contactName: 'Laura Medina',
    })
    expect(lines[0]).toContain('Valoración con el Dr.')
    expect(lines[1]).toContain('apartada en el sistema')
    expect(lines[1]).toContain('pendiente de que el equipo la confirme')
    expect(lines[3]).toContain('PENDIENTE')
    expect(lines[3]).toContain('350')
    expect(lines[4]).toContain('prevalidar_anticipo')
  })

  it('pago pendiente en revisión: no volver a cobrar, siguiente = esperar al equipo', async () => {
    const db = fakeDb({
      appointments: [APPT_PENDIENTE],
      payments: [
        {
          account_id: 'acc-1',
          contact_id: 'contact-1',
          status: 'pendiente',
          amount: '350',
          currency: 'MXN',
          created_at: '2026-07-08T15:00:00Z',
        },
      ],
      procedures: PROCEDURES,
    })
    const lines = await buildReceptionFlowLines({
      db: db as never,
      ...BASE,
      contactName: 'Laura Medina',
    })
    expect(lines[3]).toContain('EN REVISIÓN')
    expect(lines[3]).toContain('No le vuelvas a pedir el pago')
    expect(lines[4]).toContain('esperar la validación del equipo')
  })

  it('cita confirmada con anticipo pagado: flujo completo, nada pendiente', async () => {
    const db = fakeDb({
      appointments: [
        { ...APPT_PENDIENTE, status: 'confirmada', deposit_status: 'pagado' },
      ],
      payments: [],
      procedures: PROCEDURES,
    })
    const lines = await buildReceptionFlowLines({
      db: db as never,
      ...BASE,
      contactName: 'Laura Medina',
    })
    expect(lines[1]).toContain('confirmada')
    expect(lines[3]).toContain('pagado')
    expect(lines[4]).toContain('nada pendiente')
  })

  it('un error de BD degrada a [] (best-effort)', async () => {
    const broken = { from: () => { throw new Error('boom') } }
    const lines = await buildReceptionFlowLines({
      db: broken as never,
      ...BASE,
      contactName: null,
    })
    expect(lines).toEqual([])
  })
})
