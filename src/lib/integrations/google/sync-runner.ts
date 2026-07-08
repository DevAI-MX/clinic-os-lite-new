// ============================================================
// clinicOS — orquestador del drenado de la cola de sincronización.
//
// Toma los jobs pendientes de `calendar_sync_jobs`, resuelve el evento
// en el calendario "Clínica" de cada cuenta (insert/patch/delete) y
// guarda el mapeo en `calendar_event_links`. Separado de la ruta cron
// para poder testearlo con un cliente Supabase y un fetch simulados.
//
// Reintentos: un job que falla vuelve a 'pending' con backoff hasta
// MAX_ATTEMPTS; luego queda 'failed'. Un 404 al borrar/parchar NO es
// error (idempotente, lo maneja calendar.ts).
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { clinicTimezone } from '@/lib/ai/agent'
import { getFreshAccessToken } from './client'
import { deleteEvent, insertEvent, patchEvent } from './calendar'
import { planAppointmentSync, type SyncContext } from './calendar-sync'

const MAX_ATTEMPTS = 5

interface SyncJobRow {
  id: string
  account_id: string
  appointment_id: string
  operation: 'upsert' | 'delete'
  google_event_id: string | null
  google_calendar_id: string | null
  attempts: number
}

interface LinkRow {
  google_event_id: string
  google_calendar_id: string
}

/** Access token + calendario destino de una cuenta (cacheado por corrida). */
interface AccountSync {
  accessToken: string
  calendarId: string
}

export interface RunResult {
  processed: number
  failed: number
  skipped: number
}

/**
 * Drena los jobs vencidos. Deduplica por cita (procesa el último job de
 * cada cita y marca los demás como hechos). Nunca lanza: los errores se
 * registran en el job.
 */
export async function runDueCalendarSyncJobs(
  db: SupabaseClient,
  opts: { nowMs?: number; limit?: number; accountId?: string } = {},
): Promise<RunResult> {
  const nowMs = opts.nowMs ?? Date.now()
  const limit = opts.limit ?? 50
  const nowIso = new Date(nowMs).toISOString()

  // `accountId` acota el drenado a una sola cuenta: lo usa el "nudge" con
  // sesión que el panel dispara tras crear/editar una cita, para reflejar
  // ese cambio en Google al instante sin tocar las demás cuentas. Sin él
  // (el cron periódico) se drena la cola completa.
  let query = db
    .from('calendar_sync_jobs')
    .select(
      'id, account_id, appointment_id, operation, google_event_id, google_calendar_id, attempts',
    )
    .eq('status', 'pending')
    .lte('run_at', nowIso)
  if (opts.accountId) query = query.eq('account_id', opts.accountId)
  const { data: jobs, error } = await query
    .order('run_at', { ascending: true })
    .limit(limit)

  if (error || !jobs || jobs.length === 0) {
    return { processed: 0, failed: 0, skipped: 0 }
  }

  // Dedup por cita: el ÚLTIMO job gana; los previos se marcan hechos
  // (superados). Como vienen ordenados por run_at asc, el último del
  // recorrido es el más nuevo.
  const latestByAppt = new Map<string, SyncJobRow>()
  const superseded: string[] = []
  for (const j of jobs as SyncJobRow[]) {
    const prev = latestByAppt.get(j.appointment_id)
    if (prev) superseded.push(prev.id)
    latestByAppt.set(j.appointment_id, j)
  }
  if (superseded.length) {
    await db
      .from('calendar_sync_jobs')
      .update({ status: 'done' })
      .in('id', superseded)
  }

  const accountCache = new Map<string, AccountSync | null>()
  const result: RunResult = { processed: 0, failed: 0, skipped: 0 }

  for (const job of latestByAppt.values()) {
    // Claim: pending → running (lock simple, evita doble proceso).
    const { data: claim } = await db
      .from('calendar_sync_jobs')
      .update({ status: 'running' })
      .eq('id', job.id)
      .eq('status', 'pending')
      .select('id')
      .maybeSingle()
    if (!claim) continue

    try {
      const account = await resolveAccount(db, job.account_id, nowMs, accountCache)
      if (!account) {
        // La cuenta no tiene Google conectado → nada que sincronizar.
        await markDone(db, job.id)
        result.skipped++
        continue
      }
      await processJob(db, job, account)
      await markDone(db, job.id)
      result.processed++
    } catch (err) {
      await markRetry(db, job, nowMs, err)
      result.failed++
    }
  }

  return result
}

async function resolveAccount(
  db: SupabaseClient,
  accountId: string,
  nowMs: number,
  cache: Map<string, AccountSync | null>,
): Promise<AccountSync | null> {
  if (cache.has(accountId)) return cache.get(accountId) ?? null
  const fresh = await getFreshAccessToken(db, accountId, nowMs)
  const value: AccountSync | null = fresh
    ? {
        accessToken: fresh.accessToken,
        calendarId: fresh.connection.calendar_id || 'primary',
      }
    : null
  cache.set(accountId, value)
  return value
}

async function processJob(
  db: SupabaseClient,
  job: SyncJobRow,
  account: AccountSync,
): Promise<void> {
  // Camino de borrado explícito (la cita ya no existe): usa el evento
  // capturado en el job o el link.
  if (job.operation === 'delete') {
    const link = await loadLink(db, job.appointment_id)
    const eventId = job.google_event_id ?? link?.google_event_id ?? null
    const calId = job.google_calendar_id ?? link?.google_calendar_id ?? account.calendarId
    if (eventId) await deleteEvent(account.accessToken, calId, eventId)
    await deleteLink(db, job.appointment_id)
    return
  }

  // Upsert: cargar la cita y decidir. Si desapareció, se comporta como
  // delete usando el link.
  const appt = await loadAppointment(db, job.appointment_id)
  const link = await loadLink(db, job.appointment_id)

  if (!appt) {
    if (link) {
      await deleteEvent(account.accessToken, link.google_calendar_id, link.google_event_id)
      await deleteLink(db, job.appointment_id)
    }
    return
  }

  const ctx: SyncContext = {
    contactName: appt.contactName,
    procedureName: appt.procedureName,
    doctorColor: await loadDoctorColor(db, appt.doctor_id),
    timezone: clinicTimezone(),
  }
  const plan = planAppointmentSync(appt, ctx)

  if (plan.op === 'delete') {
    if (link) {
      await deleteEvent(account.accessToken, link.google_calendar_id, link.google_event_id)
      await deleteLink(db, job.appointment_id)
    }
    return
  }

  // Upsert real: parchar si hay link (y sigue existiendo en Google),
  // si no, crear.
  let saved: { id: string; etag: string | null } | null = null
  if (link) {
    saved = await patchEvent(
      account.accessToken,
      link.google_calendar_id,
      link.google_event_id,
      plan.event,
    )
  }
  if (!saved) {
    saved = await insertEvent(account.accessToken, account.calendarId, plan.event)
  }
  await upsertLink(db, {
    appointment_id: job.appointment_id,
    account_id: job.account_id,
    google_calendar_id: link?.google_calendar_id ?? account.calendarId,
    google_event_id: saved.id,
    etag: saved.etag,
  })
}

// ------------------------------------------------------------
// Acceso a datos
// ------------------------------------------------------------

interface LoadedAppointment {
  status: import('@/lib/clinic/types').AppointmentStatus
  starts_at: string
  ends_at: string
  notes: string | null
  deposit_status: import('@/lib/clinic/types').DepositStatus
  deposit_amount: number | null
  doctor_id: string | null
  contactName: string
  procedureName: string | null
}

async function loadAppointment(
  db: SupabaseClient,
  appointmentId: string,
): Promise<LoadedAppointment | null> {
  const { data } = await db
    .from('appointments')
    .select(
      'status, starts_at, ends_at, notes, deposit_status, deposit_amount, doctor_id, contact:contacts(name, phone), procedure:procedures(name)',
    )
    .eq('id', appointmentId)
    .maybeSingle()
  if (!data) return null
  // PostgREST tipa los embeds to-one como arreglo; en runtime llega un
  // objeto (o null). `oneOf` normaliza ambos casos.
  const contact = oneOf<{ name: string | null; phone: string | null }>(data.contact)
  const procedure = oneOf<{ name: string | null }>(data.procedure)
  return {
    status: data.status,
    starts_at: data.starts_at,
    ends_at: data.ends_at,
    notes: data.notes ?? null,
    deposit_status: data.deposit_status,
    deposit_amount: data.deposit_amount ?? null,
    doctor_id: (data.doctor_id as string | null) ?? null,
    contactName: contact?.name || contact?.phone || 'Cita',
    procedureName: procedure?.name ?? null,
  }
}

/** Normaliza un embed to-one de PostgREST (objeto o arreglo) a objeto|null. */
function oneOf<T>(value: unknown): T | null {
  if (value == null) return null
  return (Array.isArray(value) ? (value[0] ?? null) : value) as T | null
}

async function loadDoctorColor(
  db: SupabaseClient,
  doctorId: string | null,
): Promise<string | null> {
  if (!doctorId) return null
  const { data } = await db
    .from('profiles')
    .select('provider_color')
    .eq('user_id', doctorId)
    .maybeSingle()
  return (data?.provider_color as string | null) ?? null
}

async function loadLink(
  db: SupabaseClient,
  appointmentId: string,
): Promise<LinkRow | null> {
  const { data } = await db
    .from('calendar_event_links')
    .select('google_event_id, google_calendar_id')
    .eq('appointment_id', appointmentId)
    .maybeSingle()
  return (data as LinkRow | null) ?? null
}

async function upsertLink(
  db: SupabaseClient,
  row: {
    appointment_id: string
    account_id: string
    google_calendar_id: string
    google_event_id: string
    etag: string | null
  },
): Promise<void> {
  await db
    .from('calendar_event_links')
    .upsert(
      { ...row, last_synced_at: new Date().toISOString() },
      { onConflict: 'appointment_id' },
    )
}

async function deleteLink(db: SupabaseClient, appointmentId: string): Promise<void> {
  await db.from('calendar_event_links').delete().eq('appointment_id', appointmentId)
}

// ------------------------------------------------------------
// Estado del job
// ------------------------------------------------------------

async function markDone(db: SupabaseClient, jobId: string): Promise<void> {
  await db
    .from('calendar_sync_jobs')
    .update({ status: 'done', last_error: null })
    .eq('id', jobId)
}

async function markRetry(
  db: SupabaseClient,
  job: SyncJobRow,
  nowMs: number,
  err: unknown,
): Promise<void> {
  const attempts = job.attempts + 1
  const message = err instanceof Error ? err.message : String(err)
  if (attempts >= MAX_ATTEMPTS) {
    await db
      .from('calendar_sync_jobs')
      .update({ status: 'failed', attempts, last_error: message })
      .eq('id', job.id)
    return
  }
  // Backoff exponencial: 1, 2, 4, 8 min…
  const backoffMs = Math.min(2 ** (attempts - 1), 16) * 60_000
  await db
    .from('calendar_sync_jobs')
    .update({
      status: 'pending',
      attempts,
      last_error: message,
      run_at: new Date(nowMs + backoffMs).toISOString(),
    })
    .eq('id', job.id)
}
