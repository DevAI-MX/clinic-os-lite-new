import { describe, it, expect, vi, beforeEach } from 'vitest'

// clinicTimezone sin arrastrar todo el barrel de IA.
vi.mock('@/lib/ai/agent', () => ({
  clinicTimezone: () => 'America/Mexico_City',
}))
// Token de cuenta simulado (no toca BD ni red).
vi.mock('./client', () => ({
  getFreshAccessToken: vi.fn(),
}))
// API de Calendar simulada.
vi.mock('./calendar', () => ({
  insertEvent: vi.fn(),
  patchEvent: vi.fn(),
  deleteEvent: vi.fn(),
}))

import { runDueCalendarSyncJobs } from './sync-runner'
import { getFreshAccessToken } from './client'
import { insertEvent, patchEvent, deleteEvent } from './calendar'

const T0 = 1_700_000_000_000

interface FakeOpts {
  jobs: Record<string, unknown>[]
  appointment?: Record<string, unknown> | null
  link?: Record<string, unknown> | null
}

/** Supabase falso que cubre las cadenas que usa el runner. */
function makeFake(opts: FakeOpts) {
  const calls = {
    superseded: [] as string[],
    linkUpserts: [] as Record<string, unknown>[],
    linkDeletes: 0,
    jobUpdates: [] as Record<string, unknown>[],
    eqCalls: [] as [string, string, unknown][],
  }
  function single(table: string) {
    if (table === 'appointments') return opts.appointment ?? null
    if (table === 'calendar_event_links') return opts.link ?? null
    return null
  }
  function builder(table: string) {
    const state: { op: string; payload: Record<string, unknown> | null } = {
      op: 'select',
      payload: null,
    }
    const b: Record<string, unknown> = {
      select: () => b,
      update: (p: Record<string, unknown>) => {
        state.op = 'update'
        state.payload = p
        return b
      },
      upsert: (p: Record<string, unknown>) => {
        state.op = 'upsert'
        if (table === 'calendar_event_links') calls.linkUpserts.push(p)
        return b
      },
      delete: () => {
        state.op = 'delete'
        return b
      },
      eq: (col: string, val: unknown) => {
        calls.eqCalls.push([table, col, val])
        return b
      },
      in: (_col: string, ids: string[]) => {
        if (state.op === 'update') calls.superseded.push(...ids)
        return b
      },
      lte: () => b,
      order: () => b,
      limit: () => b,
      maybeSingle: () => {
        if (state.op === 'update') {
          // Claim exitoso (pending → running).
          return Promise.resolve({ data: { id: 'claimed' }, error: null })
        }
        return Promise.resolve({ data: single(table), error: null })
      },
      then: (resolve: (v: { data?: unknown; error: null }) => void) => {
        if (state.op === 'select' && table === 'calendar_sync_jobs') {
          resolve({ data: opts.jobs, error: null })
          return
        }
        if (state.op === 'update' && table === 'calendar_sync_jobs') {
          calls.jobUpdates.push(state.payload ?? {})
        }
        if (state.op === 'delete' && table === 'calendar_event_links') {
          calls.linkDeletes++
        }
        resolve({ error: null })
      },
    }
    return b
  }
  return { db: { from: (t: string) => builder(t) } as never, calls }
}

function job(overrides: Record<string, unknown> = {}) {
  return {
    id: 'j1',
    account_id: 'acc-1',
    appointment_id: 'a1',
    operation: 'upsert',
    google_event_id: null,
    google_calendar_id: null,
    attempts: 0,
    ...overrides,
  }
}

function appt(overrides: Record<string, unknown> = {}) {
  return {
    status: 'confirmada',
    starts_at: '2026-07-10T16:00:00.000Z',
    ends_at: '2026-07-10T17:00:00.000Z',
    notes: null,
    deposit_status: 'no_aplica',
    deposit_amount: null,
    doctor_id: null,
    contact: { name: 'Laura Medina', phone: '5210000000' },
    procedure: { name: 'Valoración' },
    ...overrides,
  }
}

beforeEach(() => {
  vi.mocked(getFreshAccessToken).mockReset()
  vi.mocked(insertEvent).mockReset()
  vi.mocked(patchEvent).mockReset()
  vi.mocked(deleteEvent).mockReset()
  vi.mocked(getFreshAccessToken).mockResolvedValue({
    accessToken: 'tok',
    connection: { calendar_id: 'cal-1' } as never,
  })
})

describe('runDueCalendarSyncJobs', () => {
  it('sin conexión de Google, salta el job (no llama a Calendar)', async () => {
    vi.mocked(getFreshAccessToken).mockResolvedValue(null)
    const { db } = makeFake({ jobs: [job()], appointment: appt() })
    const res = await runDueCalendarSyncJobs(db, { nowMs: T0 })
    expect(res.skipped).toBe(1)
    expect(insertEvent).not.toHaveBeenCalled()
  })

  it('con accountId, acota la cola de jobs a esa cuenta', async () => {
    vi.mocked(insertEvent).mockResolvedValue({ id: 'ev-1', etag: 'et-1' })
    const { db, calls } = makeFake({ jobs: [job()], appointment: appt(), link: null })
    const res = await runDueCalendarSyncJobs(db, { nowMs: T0, accountId: 'acc-1' })

    expect(res.processed).toBe(1)
    // El filtro por cuenta se aplica a la SELECT de la cola.
    expect(
      calls.eqCalls.some(
        ([t, c, v]) =>
          t === 'calendar_sync_jobs' && c === 'account_id' && v === 'acc-1',
      ),
    ).toBe(true)
  })

  it('sin accountId, NO filtra la cola por cuenta (cron completo)', async () => {
    vi.mocked(insertEvent).mockResolvedValue({ id: 'ev-1', etag: 'et-1' })
    const { db, calls } = makeFake({ jobs: [job()], appointment: appt(), link: null })
    await runDueCalendarSyncJobs(db, { nowMs: T0 })

    expect(
      calls.eqCalls.some(
        ([t, c]) => t === 'calendar_sync_jobs' && c === 'account_id',
      ),
    ).toBe(false)
  })

  it('upsert sin link: crea el evento y guarda el link', async () => {
    vi.mocked(insertEvent).mockResolvedValue({ id: 'ev-1', etag: 'et-1' })
    const { db, calls } = makeFake({ jobs: [job()], appointment: appt(), link: null })
    const res = await runDueCalendarSyncJobs(db, { nowMs: T0 })

    expect(res.processed).toBe(1)
    expect(insertEvent).toHaveBeenCalledTimes(1)
    expect(patchEvent).not.toHaveBeenCalled()
    expect(calls.linkUpserts).toHaveLength(1)
    expect(calls.linkUpserts[0]).toMatchObject({
      appointment_id: 'a1',
      google_event_id: 'ev-1',
      google_calendar_id: 'cal-1',
    })
  })

  it('upsert con link existente: parcha el evento', async () => {
    vi.mocked(patchEvent).mockResolvedValue({ id: 'ev-1', etag: 'et-2' })
    const { db, calls } = makeFake({
      jobs: [job()],
      appointment: appt(),
      link: { google_event_id: 'ev-1', google_calendar_id: 'cal-1' },
    })
    const res = await runDueCalendarSyncJobs(db, { nowMs: T0 })

    expect(res.processed).toBe(1)
    expect(patchEvent).toHaveBeenCalledTimes(1)
    expect(insertEvent).not.toHaveBeenCalled()
    expect(calls.linkUpserts).toHaveLength(1)
  })

  it('cita cancelada con link: borra el evento y el link', async () => {
    const { db, calls } = makeFake({
      jobs: [job()],
      appointment: appt({ status: 'cancelada' }),
      link: { google_event_id: 'ev-1', google_calendar_id: 'cal-1' },
    })
    const res = await runDueCalendarSyncJobs(db, { nowMs: T0 })

    expect(res.processed).toBe(1)
    expect(deleteEvent).toHaveBeenCalledWith('tok', 'cal-1', 'ev-1')
    expect(calls.linkDeletes).toBe(1)
    expect(insertEvent).not.toHaveBeenCalled()
  })

  it('job de delete usa el evento capturado (cita ya borrada)', async () => {
    const { db } = makeFake({
      jobs: [
        job({
          operation: 'delete',
          google_event_id: 'ev-9',
          google_calendar_id: 'cal-1',
        }),
      ],
      appointment: null,
      link: null,
    })
    await runDueCalendarSyncJobs(db, { nowMs: T0 })
    expect(deleteEvent).toHaveBeenCalledWith('tok', 'cal-1', 'ev-9')
  })

  it('deduplica dos jobs de la misma cita: procesa uno, marca el otro', async () => {
    vi.mocked(insertEvent).mockResolvedValue({ id: 'ev-1', etag: null })
    const jobs = [
      job({ id: 'jOld' }),
      job({ id: 'jNew' }),
    ]
    const { db, calls } = makeFake({ jobs, appointment: appt(), link: null })
    const res = await runDueCalendarSyncJobs(db, { nowMs: T0 })

    expect(res.processed).toBe(1)
    expect(insertEvent).toHaveBeenCalledTimes(1)
    expect(calls.superseded).toContain('jOld')
  })
})
