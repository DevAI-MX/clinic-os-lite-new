import { describe, it, expect } from 'vitest'
import { executeConfirmedAction, type ExecuteConfirmedActionArgs } from './actions'

// ------------------------------------------------------------
// Fake Supabase en memoria (mismo patrón que execute.test.ts).
// Aquí se prueba el OTRO lado del contrato propose→confirm: la
// ejecución re-valida contra la BD al momento de confirmar (pagos ya
// resueltos, huecos ocupados, etapas ajenas) y muta con la misma
// forma que el panel.
// ------------------------------------------------------------

type Row = Record<string, unknown>

let idSeq = 0

class Builder {
  private filters: ((r: Row) => boolean)[] = []
  private _limit: number | null = null
  private op: 'select' | 'insert' | 'update' = 'select'
  private payload: Row | null = null

  constructor(
    private table: string,
    private store: Record<string, Row[]>,
  ) {}

  select() {
    return this
  }
  insert(row: Row) {
    this.op = 'insert'
    this.payload = row
    return this
  }
  update(patch: Row) {
    this.op = 'update'
    this.payload = patch
    return this
  }
  eq(col: string, val: unknown) {
    this.filters.push((r) => r[col] === val)
    return this
  }
  in(col: string, vals: unknown[]) {
    this.filters.push((r) => vals.includes(r[col]))
    return this
  }
  gt(col: string, val: string) {
    this.filters.push((r) => String(r[col]) > val)
    return this
  }
  lt(col: string, val: string) {
    this.filters.push((r) => String(r[col]) < val)
    return this
  }
  limit(n: number) {
    this._limit = n
    return this
  }

  private run(): Row[] {
    const rows = this.store[this.table] ?? []
    if (this.op === 'insert') {
      const inserted: Row = { id: `${this.table}-${++idSeq}`, ...this.payload }
      this.store[this.table] = [...rows, inserted]
      return [inserted]
    }
    let matched = rows.filter((r) => this.filters.every((f) => f(r)))
    if (this.op === 'update') {
      for (const r of matched) Object.assign(r, this.payload)
    }
    if (this._limit != null) matched = matched.slice(0, this._limit)
    return matched
  }

  single() {
    const rows = this.run()
    return Promise.resolve({
      data: rows[0] ?? null,
      error: rows.length === 0 ? { message: 'no rows' } : null,
    })
  }
  maybeSingle() {
    return Promise.resolve({ data: this.run()[0] ?? null, error: null })
  }
  then(resolve: (v: { data: Row[]; error: null }) => void) {
    resolve({ data: this.run(), error: null })
  }
}

function fakeDb(seed: Record<string, Row[]> = {}) {
  const store: Record<string, Row[]> = JSON.parse(JSON.stringify(seed))
  return {
    store,
    from(table: string) {
      return new Builder(table, store)
    },
  }
}

const ACCOUNT = 'acc-1'
const USER = 'user-1'
const NOW = new Date('2026-07-08T16:00:00Z')

function argsWith(
  db: ReturnType<typeof fakeDb>,
  toolName: ExecuteConfirmedActionArgs['toolName'],
  input: Record<string, unknown>,
): ExecuteConfirmedActionArgs {
  return {
    db: db as never,
    accountId: ACCOUNT,
    userId: USER,
    timezone: 'America/Mexico_City',
    now: NOW,
    toolName,
    input,
  }
}

describe('validar_anticipo (confirmado)', () => {
  it('confirma el pago y marca la cita con anticipo pagado + confirmada', async () => {
    const db = fakeDb({
      payments: [
        {
          id: 'p-1',
          account_id: ACCOUNT,
          appointment_id: 'a-1',
          amount: 350,
          currency: 'MXN',
          status: 'pendiente',
        },
      ],
      appointments: [
        { id: 'a-1', account_id: ACCOUNT, status: 'pendiente', deposit_status: 'pendiente' },
      ],
    })

    const result = await executeConfirmedAction(
      argsWith(db, 'validar_anticipo', { payment_id: 'p-1' }),
    )

    expect(result.payment_id).toBe('p-1')
    expect(db.store.payments[0].status).toBe('confirmado')
    expect(db.store.payments[0].confirmed_by).toBe(USER)
    expect(db.store.appointments[0].deposit_status).toBe('pagado')
    // La cita pendiente pasa a confirmada (mismo criterio que el panel).
    expect(db.store.appointments[0].status).toBe('confirmada')
  })

  it('si el pago ya fue resuelto por alguien más, falla legible sin doble-confirmar', async () => {
    const db = fakeDb({
      payments: [
        { id: 'p-1', account_id: ACCOUNT, amount: 350, status: 'confirmado' },
      ],
    })
    await expect(
      executeConfirmedAction(argsWith(db, 'validar_anticipo', { payment_id: 'p-1' })),
    ).rejects.toThrow(/ya fue resuelto/)
  })
})

describe('reagendar_cita (confirmado)', () => {
  const APPT = {
    id: 'a-1',
    account_id: ACCOUNT,
    starts_at: '2026-07-09T16:00:00Z',
    ends_at: '2026-07-09T17:00:00Z',
    status: 'pendiente',
  }

  it('mueve la cita conservando su duración', async () => {
    const db = fakeDb({ appointments: [APPT] })
    await executeConfirmedAction(
      argsWith(db, 'reagendar_cita', {
        appointment_id: 'a-1',
        inicio: '2026-07-10T16:00:00.000Z',
      }),
    )
    expect(db.store.appointments[0].starts_at).toBe('2026-07-10T16:00:00.000Z')
    expect(db.store.appointments[0].ends_at).toBe('2026-07-10T17:00:00.000Z')
  })

  it('si el hueco se ocupó entre propuesta y confirmación, falla sin doble-book', async () => {
    const db = fakeDb({
      appointments: [
        APPT,
        {
          id: 'a-2',
          account_id: ACCOUNT,
          starts_at: '2026-07-10T16:30:00Z',
          ends_at: '2026-07-10T17:30:00Z',
          status: 'confirmada',
        },
      ],
    })
    await expect(
      executeConfirmedAction(
        argsWith(db, 'reagendar_cita', {
          appointment_id: 'a-1',
          inicio: '2026-07-10T16:00:00.000Z',
        }),
      ),
    ).rejects.toThrow(/ya no está libre/)
    expect(db.store.appointments[0].starts_at).toBe('2026-07-09T16:00:00Z')
  })

  it('si la cita ya se canceló, falla legible', async () => {
    const db = fakeDb({ appointments: [{ ...APPT, status: 'cancelada' }] })
    await expect(
      executeConfirmedAction(
        argsWith(db, 'reagendar_cita', {
          appointment_id: 'a-1',
          inicio: '2026-07-10T16:00:00.000Z',
        }),
      ),
    ).rejects.toThrow(/ya no se puede reagendar/)
  })
})

describe('agendar_cita (confirmado)', () => {
  it('sin anticipo requerido nace confirmada (la confirmación del doctor ES la decisión)', async () => {
    const db = fakeDb({ contacts: [{ id: 'c-1', account_id: ACCOUNT }] })
    const result = await executeConfirmedAction(
      argsWith(db, 'agendar_cita', {
        contact_id: 'c-1',
        inicio: '2026-07-10T16:00:00.000Z',
      }),
    )
    expect(result.appointment_id).toBeTruthy()
    expect(db.store.appointments[0].status).toBe('confirmada')
    expect(db.store.appointments[0].deposit_status).toBe('no_aplica')
    expect(db.store.appointments[0].created_by).toBe(USER)
  })

  it('con procedimiento con anticipo nace pendiente de anticipo (mismo criterio que el panel)', async () => {
    const db = fakeDb({
      procedures: [
        {
          id: 'proc-1',
          account_id: ACCOUNT,
          duration_minutes: 30,
          deposit_amount: 350,
        },
      ],
    })
    await executeConfirmedAction(
      argsWith(db, 'agendar_cita', {
        contact_id: 'c-1',
        inicio: '2026-07-10T16:00:00.000Z',
        procedure_id: 'proc-1',
      }),
    )
    const appt = db.store.appointments[0]
    expect(appt.status).toBe('pendiente')
    expect(appt.deposit_status).toBe('pendiente')
    expect(appt.deposit_amount).toBe(350)
    // Duración del procedimiento: 30 min.
    expect(appt.ends_at).toBe('2026-07-10T16:30:00.000Z')
  })
})

describe('mover_deal (confirmado)', () => {
  it('mueve el deal a la etapa destino', async () => {
    const db = fakeDb({
      deals: [{ id: 'd-1', account_id: ACCOUNT, pipeline_id: 'pipe-1', stage_id: 'st-1' }],
      pipeline_stages: [
        { id: 'st-1', pipeline_id: 'pipe-1', name: 'Interesado' },
        { id: 'st-2', pipeline_id: 'pipe-1', name: 'Cita apartada' },
      ],
    })
    await executeConfirmedAction(
      argsWith(db, 'mover_deal', { deal_id: 'd-1', stage_id: 'st-2' }),
    )
    expect(db.store.deals[0].stage_id).toBe('st-2')
  })

  it('rechaza etapas de otro pipeline', async () => {
    const db = fakeDb({
      deals: [{ id: 'd-1', account_id: ACCOUNT, pipeline_id: 'pipe-1', stage_id: 'st-1' }],
      pipeline_stages: [{ id: 'st-x', pipeline_id: 'OTRO', name: 'Ajena' }],
    })
    await expect(
      executeConfirmedAction(argsWith(db, 'mover_deal', { deal_id: 'd-1', stage_id: 'st-x' })),
    ).rejects.toThrow(/no pertenece/)
  })
})

describe('crear_nota_paciente (confirmado)', () => {
  it('inserta la nota con source equipo y created_by del que confirmó', async () => {
    const db = fakeDb()
    await executeConfirmedAction(
      argsWith(db, 'crear_nota_paciente', {
        contact_id: 'c-1',
        categoria: 'nota',
        dato: 'Paciente prefiere citas por la tarde',
      }),
    )
    const rec = db.store.patient_records[0]
    expect(rec.source).toBe('equipo')
    expect(rec.created_by).toBe(USER)
    expect(rec.category).toBe('nota')
  })
})

describe('actualizar_estado_cita (confirmado)', () => {
  it('actualiza el estado', async () => {
    const db = fakeDb({
      appointments: [{ id: 'a-1', account_id: ACCOUNT, status: 'confirmada' }],
    })
    await executeConfirmedAction(
      argsWith(db, 'actualizar_estado_cita', { appointment_id: 'a-1', estado: 'completada' }),
    )
    expect(db.store.appointments[0].status).toBe('completada')
  })

  it('estado inválido → error', async () => {
    const db = fakeDb({
      appointments: [{ id: 'a-1', account_id: ACCOUNT, status: 'confirmada' }],
    })
    await expect(
      executeConfirmedAction(
        argsWith(db, 'actualizar_estado_cita', { appointment_id: 'a-1', estado: 'pendiente' }),
      ),
    ).rejects.toThrow()
  })
})
