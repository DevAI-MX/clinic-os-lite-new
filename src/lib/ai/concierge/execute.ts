// ============================================================
// clinicOS — ejecutor de las herramientas del Concierge.
//
// Corre SIEMPRE con el cliente RLS del usuario logueado (ctx.db) y
// filtra además por account_id (defensa en profundidad, igual que el
// asistente interno).
//
// Lectura: consulta directa. Escritura: el ejecutor NO muta nada —
// valida el input contra la BD, inserta la propuesta en
// assistant_actions ('proposed', expira en 15 min) y le devuelve al
// modelo un tool_result explícito: "propuesta mostrada al usuario, NO
// ejecutada, espera su decisión". La mutación real vive en actions.ts
// y solo corre tras la confirmación del humano.
// ============================================================

import {
  formatSlotLabel,
  instantFromLocalDateTime,
  wallPartsInTz,
  type AgentToolContext,
  type ToolExecResult,
  type ToolExecutor,
} from '../agent'
import { executeClinicalTool } from '../agent/execute'
import { RECORD_CATEGORIES } from '../agent/tools'
import {
  CONCIERGE_APPT_STATUSES,
  CONCIERGE_WRITE_TOOL_NAMES,
  TOOL_STATUS_LABEL,
  type ConciergeWriteToolName,
} from './tools'
import {
  CONCIERGE_SECTIONS,
  type ConciergeBlock,
  type ConciergeSectionKey,
} from './blocks'

/** Vida de una propuesta sin resolver. Después la UI la pinta expirada
 *  y el endpoint de confirmación la rechaza. */
export const ACTION_EXPIRY_MINUTES = 15

/** Propuesta tal como la consume la UI (evento action_proposal y
 *  tarjeta de confirmación). */
export interface ProposedAction {
  id: string
  toolName: ConciergeWriteToolName
  summary: string
  details: Record<string, string>
  status: 'proposed'
  expiresAt: string
}

/** Eventos que el ejecutor emite hacia el stream NDJSON del chat. */
export interface ConciergeExecEvents {
  onStatus?: (label: string) => void
  onProposal?: (action: ProposedAction) => void
  /** Bloques estructurados (widget de agenda, chip de navegación…). */
  onBlock?: (block: ConciergeBlock) => void
}

function ok(payload: Record<string, unknown>): ToolExecResult {
  return { content: JSON.stringify(payload) }
}
function fail(message: string): ToolExecResult {
  return { content: JSON.stringify({ ok: false, error: message }), isError: true }
}

const APPT_STATUS_LABEL: Record<string, string> = {
  pendiente: 'pendiente de confirmar',
  confirmada: 'confirmada',
  completada: 'completada',
  cancelada: 'cancelada',
  no_asistio: 'no asistió',
}

function fmtMoney(amount: unknown, currency = 'MXN'): string | null {
  const n = typeof amount === 'number' ? amount : Number(amount)
  return Number.isFinite(n) ? `$${n} ${currency}` : null
}

/** Detecta si un string trae zona (Z u offset) → instante absoluto. */
function hasExplicitZone(raw: string): boolean {
  return /([zZ]|[+-]\d\d:?\d\d)$/.test(raw.trim())
}

/** Instante desde ISO absoluto, o desde hora local "YYYY-MM-DDTHH:MM".
 *  (Mismo criterio que el ejecutor clínico.) */
export function parseStartInstant(raw: string, tz: string): Date | null {
  const s = raw.trim()
  if (hasExplicitZone(s)) {
    const d = new Date(s)
    return Number.isNaN(d.getTime()) ? null : d
  }
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/)
  if (!m) return null
  return instantFromLocalDateTime(
    tz,
    { year: +m[1], month: +m[2], day: +m[3] },
    { hour: +m[4], minute: +m[5] },
  )
}

async function contactName(
  ctx: AgentToolContext,
  contactId: string,
): Promise<string | null> {
  const { data } = await ctx.db
    .from('contacts')
    .select('name, phone')
    .eq('account_id', ctx.accountId)
    .eq('id', contactId)
    .maybeSingle()
  if (!data) return null
  return (data.name as string) || (data.phone as string) || 'Sin nombre'
}

async function contactNamesById(
  ctx: AgentToolContext,
  ids: string[],
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map()
  const { data } = await ctx.db
    .from('contacts')
    .select('id, name, phone')
    .eq('account_id', ctx.accountId)
    .in('id', ids)
  return new Map(
    (data ?? []).map((c) => [c.id as string, (c.name as string) || (c.phone as string)]),
  )
}

// ------------------------------------------------------------
// Lectura (variantes con IDs de las tools internas)
// ------------------------------------------------------------

async function consultarAgendaDia(
  ctx: AgentToolContext,
  args: { fecha?: string },
  events?: ConciergeExecEvents,
): Promise<ToolExecResult> {
  const raw = typeof args.fecha === 'string' ? args.fecha.trim() : ''
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})/)
  const wall = m
    ? { year: +m[1], month: +m[2], day: +m[3] }
    : wallPartsInTz(ctx.now, ctx.timezone)
  const dayStart = instantFromLocalDateTime(ctx.timezone, wall, { hour: 0, minute: 0 })
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  const fecha = `${wall.year}-${pad(wall.month)}-${pad(wall.day)}`

  const { data: appts, error } = await ctx.db
    .from('appointments')
    .select('id, contact_id, starts_at, status, appointment_type, deposit_status, deposit_amount')
    .eq('account_id', ctx.accountId)
    .gte('starts_at', dayStart.toISOString())
    .lt('starts_at', dayEnd.toISOString())
    .order('starts_at', { ascending: true })
  if (error) return fail(`No pude leer la agenda: ${error.message}`)

  if (!appts || appts.length === 0) {
    events?.onBlock?.({ kind: 'agenda', fecha, citas: [] })
    return ok({
      ok: true,
      citas: [],
      nota: 'No hay citas agendadas ese día. El chat ya muestra el widget de agenda vacío; no repitas la lista en texto.',
    })
  }

  const nameById = await contactNamesById(ctx, [
    ...new Set(appts.map((a) => a.contact_id as string)),
  ])

  const citas = appts.map((a) => ({
    appointment_id: a.id as string,
    contact_id: a.contact_id as string,
    paciente: nameById.get(a.contact_id as string) ?? 'Sin nombre',
    hora: formatSlotLabel(new Date(a.starts_at as string), ctx.timezone),
    tipo: (a.appointment_type as string | null) ?? null,
    estado: a.status as string,
    estado_label: APPT_STATUS_LABEL[a.status as string] ?? (a.status as string),
    anticipo_estado: (a.deposit_status as string) ?? 'no_aplica',
    anticipo:
      a.deposit_status === 'pendiente'
        ? `pendiente${a.deposit_amount != null ? ` (${fmtMoney(a.deposit_amount)})` : ''}`
        : a.deposit_status === 'pagado'
          ? 'pagado'
          : 'no aplica',
  }))

  events?.onBlock?.({ kind: 'agenda', fecha, citas })

  return ok({
    ok: true,
    total: citas.length,
    // El modelo sigue viendo la etiqueta legible como "estado".
    citas: citas.map((c) => ({
      appointment_id: c.appointment_id,
      contact_id: c.contact_id,
      paciente: c.paciente,
      hora: c.hora,
      tipo: c.tipo,
      estado: c.estado_label,
      anticipo: c.anticipo,
    })),
    nota: 'El chat ya muestra estas citas como TARJETA DE AGENDA; no repitas la lista completa en texto — resume y responde lo que te preguntaron.',
  })
}

/** Navegación autónoma: emite el bloque (el cliente navega en vivo) y
 *  le confirma al modelo que la vista quedó abierta. No toca la BD. */
function abrirSeccion(
  args: { seccion?: string },
  events?: ConciergeExecEvents,
): ToolExecResult {
  const key = typeof args.seccion === 'string' ? args.seccion.trim() : ''
  const section = CONCIERGE_SECTIONS[key as ConciergeSectionKey]
  if (!section) {
    return fail(
      `Sección desconocida: "${key}". Usa una de: ${Object.keys(CONCIERGE_SECTIONS).join(', ')}.`,
    )
  }
  events?.onBlock?.({
    kind: 'navegacion',
    seccion: key,
    href: section.href,
    label: section.label,
  })
  return ok({
    ok: true,
    seccion: key,
    nota: `La sección "${section.label}" quedó abierta en la pantalla del usuario (salió del chat). Cierra tu respuesta breve — la puede escuchar por voz o leer al volver.`,
  })
}

async function consultarAnticiposPendientes(
  ctx: AgentToolContext,
): Promise<ToolExecResult> {
  const { data: payments, error } = await ctx.db
    .from('payments')
    .select('id, contact_id, appointment_id, amount, currency, method, receipt_url, created_at')
    .eq('account_id', ctx.accountId)
    .eq('status', 'pendiente')
    .order('created_at', { ascending: true })
  if (error) return fail(`No pude leer los anticipos: ${error.message}`)

  if (!payments || payments.length === 0) {
    return ok({ ok: true, anticipos: [], nota: 'No hay anticipos pendientes de revisión.' })
  }

  const nameById = await contactNamesById(ctx, [
    ...new Set(payments.map((p) => p.contact_id as string)),
  ])

  const anticipos = payments.map((p) => ({
    payment_id: p.id,
    contact_id: p.contact_id,
    appointment_id: p.appointment_id ?? null,
    paciente: nameById.get(p.contact_id as string) ?? 'Sin nombre',
    monto: fmtMoney(p.amount, (p.currency as string) ?? 'MXN'),
    metodo: p.method,
    comprobante: p.receipt_url ?? null,
    recibido: formatSlotLabel(new Date(p.created_at as string), ctx.timezone),
  }))

  return ok({
    ok: true,
    total: anticipos.length,
    anticipos,
    nota: 'Para confirmar uno, propón validar_anticipo con su payment_id — el usuario confirma en la tarjeta.',
  })
}

async function consultarEmbudo(ctx: AgentToolContext): Promise<ToolExecResult> {
  const { data: pipeline } = await ctx.db
    .from('pipelines')
    .select('id')
    .eq('account_id', ctx.accountId)
    .eq('name', 'Embudo IA')
    .maybeSingle()

  if (!pipeline) {
    return ok({
      ok: true,
      etapas: [],
      nota: 'El embudo de IA todavía no tiene actividad.',
    })
  }

  const { data: stages } = await ctx.db
    .from('pipeline_stages')
    .select('id, name, position')
    .eq('pipeline_id', pipeline.id)
    .order('position', { ascending: true })

  const { data: deals } = await ctx.db
    .from('deals')
    .select('id, stage_id, title, value, contact_id')
    .eq('pipeline_id', pipeline.id)
    .eq('status', 'open')

  const etapas = (stages ?? []).map((s) => {
    const inStage = (deals ?? []).filter((d) => d.stage_id === s.id)
    const valorTotal = inStage.reduce((sum, d) => sum + (Number(d.value) || 0), 0)
    return {
      stage_id: s.id,
      etapa: s.name,
      leads: inStage.length,
      valor_potencial: fmtMoney(valorTotal),
      deals: inStage.map((d) => ({
        deal_id: d.id,
        titulo: d.title,
        valor: fmtMoney(d.value),
      })),
    }
  })

  return ok({ ok: true, etapas })
}

async function buscarPaciente(
  ctx: AgentToolContext,
  args: { query?: string },
): Promise<ToolExecResult> {
  const query = typeof args.query === 'string' ? args.query.trim() : ''
  if (!query) return fail('Falta el nombre o teléfono a buscar.')

  const { data: byName, error: nameErr } = await ctx.db
    .from('contacts')
    .select('id, name, phone, email')
    .eq('account_id', ctx.accountId)
    .ilike('name', `%${query}%`)
    .limit(5)
  if (nameErr) return fail(`No pude buscar al paciente: ${nameErr.message}`)

  const { data: byPhone, error: phoneErr } = await ctx.db
    .from('contacts')
    .select('id, name, phone, email')
    .eq('account_id', ctx.accountId)
    .ilike('phone', `%${query}%`)
    .limit(5)
  if (phoneErr) return fail(`No pude buscar al paciente: ${phoneErr.message}`)

  const seen = new Map<string, Record<string, unknown>>()
  for (const c of [...(byName ?? []), ...(byPhone ?? [])]) seen.set(c.id as string, c)
  const contacts = [...seen.values()].slice(0, 5)

  if (contacts.length === 0) {
    return ok({
      ok: true,
      pacientes: [],
      nota: 'No encontré ningún paciente con ese nombre o teléfono.',
    })
  }

  const ids = contacts.map((c) => c.id as string)
  const { data: appts } = await ctx.db
    .from('appointments')
    .select('id, contact_id, starts_at, status')
    .eq('account_id', ctx.accountId)
    .in('contact_id', ids)
    .order('starts_at', { ascending: false })
    .limit(20)

  const { data: records } = await ctx.db
    .from('patient_records')
    .select('contact_id, category, content, created_at')
    .eq('account_id', ctx.accountId)
    .in('contact_id', ids)
    .eq('is_active', true)
    .order('created_at', { ascending: false })
    .limit(50)

  const pacientes = contacts.map((c) => {
    const citas = (appts ?? [])
      .filter((a) => a.contact_id === c.id)
      .slice(0, 3)
      .map((a) => ({
        appointment_id: a.id,
        cuando: formatSlotLabel(new Date(a.starts_at as string), ctx.timezone),
        estado: APPT_STATUS_LABEL[a.status as string] ?? a.status,
      }))
    const expediente = (records ?? [])
      .filter((r) => r.contact_id === c.id)
      .slice(0, 10)
      .map((r) => ({ categoria: r.category, dato: r.content }))
    return {
      contact_id: c.id,
      nombre: c.name ?? 'Sin nombre',
      telefono: c.phone,
      email: c.email ?? null,
      citas,
      expediente,
    }
  })

  return ok({ ok: true, pacientes })
}

// ------------------------------------------------------------
// Escritura → propuestas
// ------------------------------------------------------------

interface ProposalDraft {
  summary: string
  details: Record<string, string>
  /** Input ya validado/normalizado que ejecutará actions.ts. */
  args: Record<string, unknown>
}

/** Valida el input del modelo contra la BD y arma el resumen legible.
 *  Lanza Error con mensaje legible si la propuesta no es viable. */
async function draftProposal(
  name: ConciergeWriteToolName,
  input: Record<string, unknown>,
  ctx: AgentToolContext,
): Promise<ProposalDraft> {
  switch (name) {
    case 'agendar_cita': {
      const contactId = typeof input.contact_id === 'string' ? input.contact_id : ''
      const inicio = typeof input.inicio === 'string' ? input.inicio : ''
      if (!contactId) throw new Error('Falta contact_id (usa buscar_paciente).')
      const start = parseStartInstant(inicio, ctx.timezone)
      if (!start) throw new Error('No entendí la fecha/hora de inicio.')
      if (start.getTime() <= ctx.now.getTime()) {
        throw new Error('Ese horario ya pasó. Propón una fecha futura.')
      }
      const nombre = await contactName(ctx, contactId)
      if (!nombre) throw new Error('Ese contact_id no existe en esta cuenta.')

      let procName: string | null = null
      if (typeof input.procedure_id === 'string' && input.procedure_id) {
        const { data: proc } = await ctx.db
          .from('procedures')
          .select('id, name')
          .eq('account_id', ctx.accountId)
          .eq('id', input.procedure_id)
          .maybeSingle()
        if (!proc) throw new Error('Ese procedure_id no existe. Consulta el catálogo.')
        procName = proc.name as string
      }

      const label = formatSlotLabel(start, ctx.timezone)
      return {
        summary: `Agendar cita: ${nombre} — ${label}${procName ? ` · ${procName}` : ''}`,
        details: {
          Paciente: nombre,
          Cuándo: label,
          ...(procName ? { Procedimiento: procName } : {}),
          ...(typeof input.notas === 'string' && input.notas ? { Notas: input.notas } : {}),
        },
        args: {
          contact_id: contactId,
          inicio: start.toISOString(),
          tipo: input.tipo,
          procedure_id: input.procedure_id ?? null,
          notas: input.notas ?? null,
        },
      }
    }
    case 'reagendar_cita': {
      const apptId = typeof input.appointment_id === 'string' ? input.appointment_id : ''
      const inicio = typeof input.inicio === 'string' ? input.inicio : ''
      if (!apptId) throw new Error('Falta appointment_id.')
      const start = parseStartInstant(inicio, ctx.timezone)
      if (!start) throw new Error('No entendí la fecha/hora nueva.')
      if (start.getTime() <= ctx.now.getTime()) {
        throw new Error('Ese horario ya pasó. Propón una fecha futura.')
      }
      const { data: appt } = await ctx.db
        .from('appointments')
        .select('id, contact_id, starts_at, ends_at, status')
        .eq('account_id', ctx.accountId)
        .eq('id', apptId)
        .maybeSingle()
      if (!appt) throw new Error('Esa cita no existe en esta cuenta.')
      if (!['pendiente', 'confirmada'].includes(appt.status as string)) {
        throw new Error(`Esa cita está "${appt.status}"; solo se reagendan citas pendientes o confirmadas.`)
      }
      const nombre = (await contactName(ctx, appt.contact_id as string)) ?? 'Paciente'
      const oldLabel = formatSlotLabel(new Date(appt.starts_at as string), ctx.timezone)
      const newLabel = formatSlotLabel(start, ctx.timezone)
      return {
        summary: `Reagendar a ${nombre}: ${oldLabel} → ${newLabel}`,
        details: { Paciente: nombre, De: oldLabel, A: newLabel },
        args: { appointment_id: apptId, inicio: start.toISOString() },
      }
    }
    case 'actualizar_estado_cita': {
      const apptId = typeof input.appointment_id === 'string' ? input.appointment_id : ''
      const estado = typeof input.estado === 'string' ? input.estado : ''
      if (!apptId) throw new Error('Falta appointment_id.')
      if (!CONCIERGE_APPT_STATUSES.includes(estado as never)) {
        throw new Error(`Estado inválido. Usa uno de: ${CONCIERGE_APPT_STATUSES.join(', ')}.`)
      }
      const { data: appt } = await ctx.db
        .from('appointments')
        .select('id, contact_id, starts_at, status')
        .eq('account_id', ctx.accountId)
        .eq('id', apptId)
        .maybeSingle()
      if (!appt) throw new Error('Esa cita no existe en esta cuenta.')
      const nombre = (await contactName(ctx, appt.contact_id as string)) ?? 'Paciente'
      const label = formatSlotLabel(new Date(appt.starts_at as string), ctx.timezone)
      return {
        summary: `Marcar cita de ${nombre} (${label}) como ${APPT_STATUS_LABEL[estado] ?? estado}`,
        details: {
          Paciente: nombre,
          Cita: label,
          'Estado actual': APPT_STATUS_LABEL[appt.status as string] ?? (appt.status as string),
          'Estado nuevo': APPT_STATUS_LABEL[estado] ?? estado,
        },
        args: { appointment_id: apptId, estado },
      }
    }
    case 'validar_anticipo': {
      const paymentId = typeof input.payment_id === 'string' ? input.payment_id : ''
      if (!paymentId) throw new Error('Falta payment_id (usa consultar_anticipos_pendientes).')
      const { data: payment } = await ctx.db
        .from('payments')
        .select('id, contact_id, appointment_id, amount, currency, method, status, receipt_url')
        .eq('account_id', ctx.accountId)
        .eq('id', paymentId)
        .maybeSingle()
      if (!payment) throw new Error('Ese pago no existe en esta cuenta.')
      if (payment.status !== 'pendiente') {
        throw new Error(`Ese pago ya está "${payment.status}"; solo se validan pagos pendientes.`)
      }
      const nombre = (await contactName(ctx, payment.contact_id as string)) ?? 'Paciente'
      const monto = fmtMoney(payment.amount, (payment.currency as string) ?? 'MXN') ?? '—'
      return {
        summary: `Validar anticipo de ${monto} de ${nombre}`,
        details: {
          Paciente: nombre,
          Monto: monto,
          Método: (payment.method as string) ?? '—',
          Comprobante: payment.receipt_url ? 'adjunto' : 'SIN comprobante — revisa la conversación',
        },
        args: { payment_id: paymentId },
      }
    }
    case 'mover_deal': {
      const dealId = typeof input.deal_id === 'string' ? input.deal_id : ''
      const stageId = typeof input.stage_id === 'string' ? input.stage_id : ''
      if (!dealId || !stageId) throw new Error('Faltan deal_id y/o stage_id (usa consultar_embudo).')
      const { data: deal } = await ctx.db
        .from('deals')
        .select('id, title, pipeline_id, stage_id')
        .eq('account_id', ctx.accountId)
        .eq('id', dealId)
        .maybeSingle()
      if (!deal) throw new Error('Ese deal no existe en esta cuenta.')
      const { data: stage } = await ctx.db
        .from('pipeline_stages')
        .select('id, name, pipeline_id')
        .eq('id', stageId)
        .maybeSingle()
      if (!stage || stage.pipeline_id !== deal.pipeline_id) {
        throw new Error('Esa etapa no pertenece al pipeline del deal.')
      }
      const { data: current } = await ctx.db
        .from('pipeline_stages')
        .select('name')
        .eq('id', deal.stage_id as string)
        .maybeSingle()
      return {
        summary: `Mover "${deal.title}" a ${stage.name}`,
        details: {
          Lead: deal.title as string,
          De: (current?.name as string) ?? '—',
          A: stage.name as string,
        },
        args: { deal_id: dealId, stage_id: stageId },
      }
    }
    case 'crear_nota_paciente': {
      const contactId = typeof input.contact_id === 'string' ? input.contact_id : ''
      const dato = typeof input.dato === 'string' ? input.dato.trim() : ''
      const categoria =
        typeof input.categoria === 'string' && RECORD_CATEGORIES.includes(input.categoria as never)
          ? input.categoria
          : 'nota'
      if (!contactId) throw new Error('Falta contact_id.')
      if (!dato) throw new Error('Falta el dato a registrar.')
      if (dato.length > 500) throw new Error('El dato es demasiado largo (máx 500 caracteres).')
      const nombre = await contactName(ctx, contactId)
      if (!nombre) throw new Error('Ese contact_id no existe en esta cuenta.')
      return {
        summary: `Agregar ${categoria === 'nota' ? 'nota' : categoria} al expediente de ${nombre}`,
        details: { Paciente: nombre, Categoría: categoria, Dato: dato },
        args: { contact_id: contactId, categoria, dato },
      }
    }
  }
}

// ------------------------------------------------------------
// Factory del ejecutor
// ------------------------------------------------------------

export interface CreateConciergeExecutorArgs {
  sessionId: string
  events?: ConciergeExecEvents
}

/**
 * Crea el despachador de tools del Concierge para UNA corrida del chat.
 * Nunca lanza: cualquier fallo vuelve como tool_result de error (mismo
 * contrato que executeClinicalTool / executeInternalTool).
 */
export function createConciergeExecutor(
  opts: CreateConciergeExecutorArgs,
): ToolExecutor {
  return async (name, input, ctx): Promise<ToolExecResult> => {
    opts.events?.onStatus?.(TOOL_STATUS_LABEL[name] ?? 'Trabajando…')
    const args = (input ?? {}) as Record<string, unknown>
    try {
      switch (name) {
        case 'consultar_agenda_dia':
          return await consultarAgendaDia(ctx, args as never, opts.events)
        case 'consultar_anticipos_pendientes':
          return await consultarAnticiposPendientes(ctx)
        case 'consultar_embudo':
          return await consultarEmbudo(ctx)
        case 'buscar_paciente':
          return await buscarPaciente(ctx, args as never)
        case 'abrir_seccion':
          return abrirSeccion(args as never, opts.events)
        // Estas dos operan solo a escala de cuenta en el ejecutor
        // clínico (no tocan contact_id) — se delegan tal cual.
        case 'consultar_disponibilidad':
        case 'consultar_catalogo':
          return await executeClinicalTool(name, input, ctx)
        default:
          break
      }

      if (!CONCIERGE_WRITE_TOOL_NAMES.includes(name as ConciergeWriteToolName)) {
        return fail(`Herramienta desconocida: ${name}`)
      }

      const draft = await draftProposal(name as ConciergeWriteToolName, args, ctx)
      const expiresAt = new Date(
        ctx.now.getTime() + ACTION_EXPIRY_MINUTES * 60 * 1000,
      ).toISOString()

      const { data: row, error } = await ctx.db
        .from('assistant_actions')
        .insert({
          account_id: ctx.accountId,
          session_id: opts.sessionId,
          tool_name: name,
          input: { args: draft.args, display: draft.details },
          summary: draft.summary,
          status: 'proposed',
          expires_at: expiresAt,
        })
        .select('id')
        .single()
      if (error || !row) {
        return fail(`No pude registrar la propuesta: ${error?.message ?? 'error desconocido'}`)
      }

      const proposal: ProposedAction = {
        id: row.id as string,
        toolName: name as ConciergeWriteToolName,
        summary: draft.summary,
        details: draft.details,
        status: 'proposed',
        expiresAt,
      }
      opts.events?.onProposal?.(proposal)

      return ok({
        ok: true,
        propuesta_id: proposal.id,
        resumen: draft.summary,
        estado: 'propuesta_mostrada_al_usuario',
        instruccion:
          'La propuesta quedó como TARJETA en el chat y NO está ejecutada. El usuario debe confirmarla o cancelarla en la tarjeta. NUNCA afirmes que la acción quedó hecha; di que dejaste la propuesta lista para su confirmación.',
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return fail(msg)
    }
  }
}
