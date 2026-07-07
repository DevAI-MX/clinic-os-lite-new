import { describe, it, expect } from 'vitest'
import { buildPatientStateLines } from './state'

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
