import { describe, it, expect } from 'vitest'
import { createConciergeExecutor, type ProposedAction } from './execute'
import type { ConciergeBlock } from './blocks'
import type { AgentToolContext } from '../agent'

// ------------------------------------------------------------
// Fake Supabase en memoria — extiende el patrón del test del asistente
// interno con insert/update, porque el ejecutor del Concierge escribe
// propuestas en assistant_actions (y NADA más: ese es el invariante
// central que se prueba aquí).
// ------------------------------------------------------------

type Row = Record<string, unknown>

let idSeq = 0

class Builder {
  private filters: ((r: Row) => boolean)[] = []
  private _order: { col: string; asc: boolean } | null = null
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
  gte(col: string, val: string) {
    this.filters.push((r) => String(r[col]) >= val)
    return this
  }
  lt(col: string, val: string) {
    this.filters.push((r) => String(r[col]) < val)
    return this
  }
  ilike(col: string, pat: string) {
    const needle = pat.replace(/%/g, '').toLowerCase()
    this.filters.push((r) => String(r[col] ?? '').toLowerCase().includes(needle))
    return this
  }
  order(col: string, opts?: { ascending?: boolean }) {
    this._order = { col, asc: opts?.ascending !== false }
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
      return matched
    }
    if (this._order) {
      const { col, asc } = this._order
      matched = [...matched].sort(
        (a, b) => (String(a[col]) > String(b[col]) ? 1 : -1) * (asc ? 1 : -1),
      )
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
const TZ = 'America/Mexico_City'
const NOW = new Date('2026-07-08T16:00:00Z')

function ctxWith(db: ReturnType<typeof fakeDb>): AgentToolContext {
  return {
    db: db as never,
    accountId: ACCOUNT,
    contactId: '',
    conversationId: '',
    userId: 'user-1',
    contactName: null,
    timezone: TZ,
    now: NOW,
    embeddingsApiKey: null,
  }
}

function makeExecutor(
  opts: { proposals?: ProposedAction[]; blocks?: ConciergeBlock[] } = {},
) {
  return createConciergeExecutor({
    sessionId: 'sess-1',
    events: {
      onProposal: (a) => opts.proposals?.push(a),
      onBlock: (b) => opts.blocks?.push(b),
    },
  })
}

describe('tools de escritura → propuestas (nunca mutan)', () => {
  it('validar_anticipo crea la propuesta SIN tocar el pago', async () => {
    const db = fakeDb({
      payments: [
        {
          id: 'p-1',
          account_id: ACCOUNT,
          contact_id: 'c-1',
          appointment_id: 'a-1',
          amount: 350,
          currency: 'MXN',
          method: 'transferencia',
          status: 'pendiente',
          receipt_url: 'https://example.com/r.jpg',
        },
      ],
      contacts: [{ id: 'c-1', account_id: ACCOUNT, name: 'María López', phone: '555' }],
    })
    const proposals: ProposedAction[] = []
    const exec = makeExecutor({ proposals })

    const res = await exec('validar_anticipo', { payment_id: 'p-1' }, ctxWith(db))
    const out = JSON.parse(res.content)

    expect(res.isError).toBeUndefined()
    expect(out.estado).toBe('propuesta_mostrada_al_usuario')
    expect(out.instruccion).toContain('NO está ejecutada')

    // El invariante: el pago sigue intacto, solo existe la propuesta.
    expect(db.store.payments[0].status).toBe('pendiente')
    expect(db.store.assistant_actions).toHaveLength(1)
    const action = db.store.assistant_actions[0]
    expect(action.status).toBe('proposed')
    expect(action.tool_name).toBe('validar_anticipo')
    expect((action.input as { args: { payment_id: string } }).args.payment_id).toBe('p-1')
    expect(action.session_id).toBe('sess-1')

    expect(proposals).toHaveLength(1)
    expect(proposals[0].summary).toContain('María López')
    expect(proposals[0].details.Comprobante).toBe('adjunto')
  })

  it('validar_anticipo rechaza pagos que ya no están pendientes', async () => {
    const db = fakeDb({
      payments: [
        { id: 'p-1', account_id: ACCOUNT, contact_id: 'c-1', amount: 350, status: 'confirmado' },
      ],
      contacts: [{ id: 'c-1', account_id: ACCOUNT, name: 'María', phone: '555' }],
    })
    const exec = makeExecutor()
    const res = await exec('validar_anticipo', { payment_id: 'p-1' }, ctxWith(db))
    expect(res.isError).toBe(true)
    expect(db.store.assistant_actions ?? []).toHaveLength(0)
  })

  it('reagendar_cita valida la cita y arma el resumen de → sin mover nada', async () => {
    const db = fakeDb({
      appointments: [
        {
          id: 'a-1',
          account_id: ACCOUNT,
          contact_id: 'c-1',
          starts_at: '2026-07-09T16:00:00Z',
          ends_at: '2026-07-09T17:00:00Z',
          status: 'pendiente',
        },
      ],
      contacts: [{ id: 'c-1', account_id: ACCOUNT, name: 'Laura Medina', phone: '555' }],
    })
    const proposals: ProposedAction[] = []
    const exec = makeExecutor({ proposals })

    const res = await exec(
      'reagendar_cita',
      { appointment_id: 'a-1', inicio: '2026-07-10T10:00' },
      ctxWith(db),
    )

    expect(res.isError).toBeUndefined()
    expect(db.store.appointments[0].starts_at).toBe('2026-07-09T16:00:00Z')
    expect(db.store.assistant_actions).toHaveLength(1)
    expect(proposals[0].summary).toContain('Laura Medina')
    expect(proposals[0].details.De).toBeTruthy()
    expect(proposals[0].details.A).toBeTruthy()
  })

  it('propuesta con referencia inexistente → error, sin fila', async () => {
    const db = fakeDb()
    const exec = makeExecutor()
    const res = await exec(
      'agendar_cita',
      { contact_id: 'no-existe', inicio: '2026-07-10T10:00' },
      ctxWith(db),
    )
    expect(res.isError).toBe(true)
    expect(db.store.assistant_actions ?? []).toHaveLength(0)
  })

  it('herramienta desconocida → error controlado', async () => {
    const db = fakeDb()
    const exec = makeExecutor()
    const res = await exec('herramienta_falsa', {}, ctxWith(db))
    expect(res.isError).toBe(true)
  })
})

describe('tools de lectura del Concierge', () => {
  it('consultar_anticipos_pendientes incluye payment_id (lo necesita validar_anticipo)', async () => {
    const db = fakeDb({
      payments: [
        {
          id: 'p-1',
          account_id: ACCOUNT,
          contact_id: 'c-1',
          appointment_id: 'a-1',
          amount: 350,
          currency: 'MXN',
          method: 'transferencia',
          status: 'pendiente',
          receipt_url: null,
          created_at: '2026-07-08T12:00:00Z',
        },
      ],
      contacts: [{ id: 'c-1', account_id: ACCOUNT, name: 'María', phone: '555' }],
    })
    const exec = makeExecutor()
    const res = await exec('consultar_anticipos_pendientes', {}, ctxWith(db))
    const out = JSON.parse(res.content)
    expect(out.anticipos[0].payment_id).toBe('p-1')
    expect(out.anticipos[0].appointment_id).toBe('a-1')
  })

  it('consultar_agenda_dia incluye appointment_id y contact_id', async () => {
    const db = fakeDb({
      appointments: [
        {
          id: 'a-1',
          account_id: ACCOUNT,
          contact_id: 'c-1',
          starts_at: '2026-07-08T18:00:00Z',
          status: 'pendiente',
          appointment_type: 'valoracion',
          deposit_status: 'pendiente',
          deposit_amount: 350,
        },
      ],
      contacts: [{ id: 'c-1', account_id: ACCOUNT, name: 'María', phone: '555' }],
    })
    const exec = makeExecutor()
    const res = await exec('consultar_agenda_dia', {}, ctxWith(db))
    const out = JSON.parse(res.content)
    expect(out.citas[0].appointment_id).toBe('a-1')
    expect(out.citas[0].contact_id).toBe('c-1')
  })

  it('consultar_agenda_dia emite el bloque de agenda con datos crudos para el widget', async () => {
    const db = fakeDb({
      appointments: [
        {
          id: 'a-1',
          account_id: ACCOUNT,
          contact_id: 'c-1',
          starts_at: '2026-07-08T18:00:00Z',
          status: 'pendiente',
          appointment_type: 'valoracion',
          deposit_status: 'pendiente',
          deposit_amount: 350,
        },
      ],
      contacts: [{ id: 'c-1', account_id: ACCOUNT, name: 'María', phone: '555' }],
    })
    const blocks: ConciergeBlock[] = []
    const exec = makeExecutor({ blocks })

    await exec('consultar_agenda_dia', {}, ctxWith(db))

    expect(blocks).toHaveLength(1)
    const block = blocks[0]
    expect(block.kind).toBe('agenda')
    if (block.kind !== 'agenda') return
    // NOW = 2026-07-08T16:00Z → 10:00 en America/Mexico_City.
    expect(block.fecha).toBe('2026-07-08')
    expect(block.citas[0].appointment_id).toBe('a-1')
    // El widget recibe los estados CRUDOS (para colorear chips)...
    expect(block.citas[0].estado).toBe('pendiente')
    expect(block.citas[0].anticipo_estado).toBe('pendiente')
    // ...y la etiqueta legible aparte.
    expect(block.citas[0].estado_label).toBe('pendiente de confirmar')
  })

  it('agenda sin citas también emite el bloque (widget vacío)', async () => {
    const db = fakeDb()
    const blocks: ConciergeBlock[] = []
    const exec = makeExecutor({ blocks })

    await exec('consultar_agenda_dia', { fecha: '2026-07-20' }, ctxWith(db))

    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ kind: 'agenda', fecha: '2026-07-20', citas: [] })
  })

  it('consultar_embudo incluye stage_id y deal_id (los necesita mover_deal)', async () => {
    const db = fakeDb({
      pipelines: [{ id: 'pipe-1', account_id: ACCOUNT, name: 'Embudo IA' }],
      pipeline_stages: [
        { id: 'st-1', pipeline_id: 'pipe-1', name: 'Interesado', position: 1 },
      ],
      deals: [
        {
          id: 'd-1',
          pipeline_id: 'pipe-1',
          stage_id: 'st-1',
          title: 'Karla Ortiz',
          value: 700,
          status: 'open',
          contact_id: 'c-1',
        },
      ],
    })
    const exec = makeExecutor()
    const res = await exec('consultar_embudo', {}, ctxWith(db))
    const out = JSON.parse(res.content)
    expect(out.etapas[0].stage_id).toBe('st-1')
    expect(out.etapas[0].deals[0].deal_id).toBe('d-1')
  })
})

describe('abrir_seccion (navegación autónoma)', () => {
  it('emite el bloque de navegación con href de la allow-list', async () => {
    const db = fakeDb()
    const blocks: ConciergeBlock[] = []
    const exec = makeExecutor({ blocks })

    const res = await exec('abrir_seccion', { seccion: 'calendario' }, ctxWith(db))

    expect(res.isError).toBeUndefined()
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({
      kind: 'navegacion',
      seccion: 'calendario',
      href: '/calendario',
      label: 'Calendario',
    })
    // El modelo recibe la confirmación de que la vista se movió.
    const out = JSON.parse(res.content)
    expect(out.ok).toBe(true)
  })

  it('sección fuera de la allow-list → error, sin navegación', async () => {
    const db = fakeDb()
    const blocks: ConciergeBlock[] = []
    const exec = makeExecutor({ blocks })

    const res = await exec('abrir_seccion', { seccion: 'https://evil.com' }, ctxWith(db))

    expect(res.isError).toBe(true)
    expect(blocks).toHaveLength(0)
  })
})
