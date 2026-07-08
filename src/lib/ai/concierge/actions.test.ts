import { describe, it, expect, vi } from 'vitest'
import {
  confirmActionsBatch,
  confirmProposedAction,
  executeConfirmedAction,
  type ExecuteConfirmedActionArgs,
} from './actions'

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

// ------------------------------------------------------------
// confirmProposedAction / confirmActionsBatch — el gate humano del
// plan multi-paso: transición atómica por acción, ejecución secuencial
// y "un paso fallido no frena los siguientes".
// ------------------------------------------------------------

const FUTURE = '2026-07-08T17:00:00Z' // expira 1h después de NOW

function proposedRow(id: string, overrides: Row = {}): Row {
  return {
    id,
    account_id: ACCOUNT,
    session_id: 'sess-1',
    message_id: 'msg-1',
    tool_name: 'crear_nota_paciente',
    input: { args: { contact_id: 'c-1', dato: 'nota', categoria: 'nota' } },
    summary: `Paso ${id}`,
    status: 'proposed',
    expires_at: FUTURE,
    ...overrides,
  }
}

function batchArgs(
  db: ReturnType<typeof fakeDb>,
  actionIds: string[],
  execute: (a: ExecuteConfirmedActionArgs) => Promise<Record<string, unknown>>,
) {
  return {
    db: db as never,
    accountId: ACCOUNT,
    userId: USER,
    timezone: 'America/Mexico_City',
    now: NOW,
    actionIds,
    // Identidad del plan: el mensaje del asistente que lo propuso.
    sessionId: 'sess-1',
    messageId: 'msg-1',
    execute,
  }
}

describe('confirmActionsBatch (plan multi-paso)', () => {
  it('ejecuta los pasos EN ORDEN y persiste executed con su resultado', async () => {
    const db = fakeDb({
      assistant_actions: [proposedRow('act-1'), proposedRow('act-2')],
    })
    const order: string[] = []
    const execute = vi.fn(async (a: ExecuteConfirmedActionArgs) => {
      order.push(String(a.input.contact_id ?? ''))
      return { mensaje: 'ok' }
    })

    const outcomes = await confirmActionsBatch(
      batchArgs(db, ['act-1', 'act-2'], execute),
    )

    expect(outcomes.map((o) => o.status)).toEqual(['executed', 'executed'])
    expect(execute).toHaveBeenCalledTimes(2)
    expect(db.store.assistant_actions.every((r) => r.status === 'executed')).toBe(true)
    expect(db.store.assistant_actions[0].resolved_by).toBe(USER)
  })

  it('un paso fallido NO impide ejecutar los siguientes', async () => {
    const db = fakeDb({
      assistant_actions: [
        proposedRow('act-1'),
        proposedRow('act-2'),
        proposedRow('act-3'),
      ],
    })
    const execute = vi.fn(async () => ({ mensaje: 'ok' }))
    execute.mockImplementationOnce(async () => ({ mensaje: 'ok' }))
    execute.mockImplementationOnce(async () => {
      throw new Error('Ese hueco ya no está libre.')
    })

    const outcomes = await confirmActionsBatch(
      batchArgs(db, ['act-1', 'act-2', 'act-3'], execute),
    )

    expect(outcomes.map((o) => o.status)).toEqual(['executed', 'failed', 'executed'])
    expect(outcomes[1].error).toContain('hueco')
    const rows = db.store.assistant_actions
    expect(rows.find((r) => r.id === 'act-2')?.status).toBe('failed')
    expect(rows.find((r) => r.id === 'act-3')?.status).toBe('executed')
  })

  it('rechaza acciones de OTRA cuenta o que ya no están proposed (conflict, sin ejecutar)', async () => {
    const db = fakeDb({
      assistant_actions: [
        proposedRow('act-otra-cuenta', { account_id: 'acc-ajena' }),
        proposedRow('act-resuelta', { status: 'executed' }),
        proposedRow('act-expirada', { expires_at: '2026-07-08T15:00:00Z' }),
        proposedRow('act-ok'),
      ],
    })
    const execute = vi.fn(async () => ({ mensaje: 'ok' }))

    const outcomes = await confirmActionsBatch(
      batchArgs(db, ['act-otra-cuenta', 'act-resuelta', 'act-expirada', 'act-ok'], execute),
    )

    expect(outcomes.map((o) => o.status)).toEqual([
      'conflict',
      'conflict',
      'conflict',
      'executed',
    ])
    // Solo el paso válido llegó al ejecutor.
    expect(execute).toHaveBeenCalledTimes(1)
    // La fila ajena no se tocó.
    expect(
      db.store.assistant_actions.find((r) => r.id === 'act-otra-cuenta')?.status,
    ).toBe('proposed')
  })

  it('rechaza acciones de OTRO mensaje u OTRA sesión (conflict, sin ejecutar) y corre en orden las del plan', async () => {
    const db = fakeDb({
      assistant_actions: [
        proposedRow('act-1'),
        proposedRow('act-otro-msg', { message_id: 'msg-AJENO' }),
        proposedRow('act-otra-sesion', { session_id: 'sess-AJENA' }),
        proposedRow('act-2'),
      ],
    })
    const order: string[] = []
    const execute = vi.fn(async (a: ExecuteConfirmedActionArgs) => {
      order.push(String(a.input.dato ?? ''))
      return { mensaje: 'ok' }
    })
    db.store.assistant_actions.find((r) => r.id === 'act-1')!.input = {
      args: { contact_id: 'c-1', dato: 'primera', categoria: 'nota' },
    }
    db.store.assistant_actions.find((r) => r.id === 'act-2')!.input = {
      args: { contact_id: 'c-1', dato: 'segunda', categoria: 'nota' },
    }

    const outcomes = await confirmActionsBatch(
      batchArgs(db, ['act-1', 'act-otro-msg', 'act-otra-sesion', 'act-2'], execute),
    )

    expect(outcomes.map((o) => o.status)).toEqual([
      'executed',
      'conflict',
      'conflict',
      'executed',
    ])
    expect(outcomes[1].error).toContain('no pertenece a este plan')
    expect(outcomes[2].error).toContain('no pertenece a este plan')
    // Solo los pasos del plan llegaron al ejecutor, EN ORDEN.
    expect(execute).toHaveBeenCalledTimes(2)
    expect(order).toEqual(['primera', 'segunda'])
    // Las propuestas ajenas quedaron intactas (siguen proposed, sin
    // resolved_by): nadie las tocó.
    for (const id of ['act-otro-msg', 'act-otra-sesion']) {
      const row = db.store.assistant_actions.find((r) => r.id === id)
      expect(row?.status).toBe('proposed')
      expect(row?.resolved_by).toBeUndefined()
    }
  })

  it('un action_id inexistente vuelve como conflict sin frenar el resto del plan', async () => {
    const db = fakeDb({ assistant_actions: [proposedRow('act-1')] })
    const execute = vi.fn(async () => ({ mensaje: 'ok' }))

    const outcomes = await confirmActionsBatch(
      batchArgs(db, ['act-fantasma', 'act-1'], execute),
    )

    expect(outcomes.map((o) => o.status)).toEqual(['conflict', 'executed'])
    expect(outcomes[0].error).toContain('no pertenece a este plan')
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('confirmProposedAction: doble confirmación → la segunda es conflict', async () => {
    const db = fakeDb({ assistant_actions: [proposedRow('act-1')] })
    const execute = vi.fn(async () => ({ mensaje: 'ok' }))
    const base = { ...batchArgs(db, [], execute), actionId: 'act-1' }

    const first = await confirmProposedAction(base)
    const second = await confirmProposedAction(base)

    expect(first.status).toBe('executed')
    expect(second.status).toBe('conflict')
    expect(execute).toHaveBeenCalledTimes(1)
  })
})
