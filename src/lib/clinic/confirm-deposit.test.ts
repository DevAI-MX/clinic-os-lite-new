import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

// El embudo y el envío de WhatsApp tienen sus propios tests; aquí se
// prueba la orquestación de confirmAppointmentDeposit.
const h = vi.hoisted(() => ({
  sendMessageToConversation: vi.fn(),
  advanceFunnelDeal: vi.fn(),
}))
vi.mock('@/lib/whatsapp/send-message', () => ({
  sendMessageToConversation: h.sendMessageToConversation,
}))
vi.mock('@/lib/ai/agent/execute', () => ({
  advanceFunnelDealOnDepositConfirmed: h.advanceFunnelDeal,
}))

import {
  confirmAppointmentDeposit,
  buildConfirmationMessage,
  ConfirmDepositError,
} from './confirm-deposit'

// ------------------------------------------------------------
// Fake de Supabase: registra updates/inserts y devuelve respuestas
// configurables por tabla. Cada método del chain devuelve el chain;
// los terminales (maybeSingle / select tras update / insert) resuelven.
// ------------------------------------------------------------

interface FakeState {
  appointment: Record<string, unknown> | null
  payment: Record<string, unknown> | null
  claimRows: Record<string, unknown>[]
  contact: Record<string, unknown> | null
  fallbackConversation: Record<string, unknown> | null
  paymentUpdates: Record<string, unknown>[]
  paymentInserts: Record<string, unknown>[]
  appointmentUpdates: Record<string, unknown>[]
  notificationInserts: Record<string, unknown>[]
}

function makeState(over: Partial<FakeState> = {}): FakeState {
  return {
    appointment: {
      id: 'appt-1',
      contact_id: 'contact-1',
      conversation_id: 'conv-1',
      status: 'pendiente',
      deposit_status: 'pendiente',
      deposit_amount: 350,
      starts_at: '2026-07-08T22:00:00Z',
      procedure: { name: 'Valoración general', currency: 'MXN' },
    },
    payment: { id: 'pay-1', status: 'pendiente' },
    claimRows: [{ id: 'appt-1', status: 'confirmada' }],
    contact: { name: 'Emiliano', phone: '5214444220456' },
    fallbackConversation: null,
    paymentUpdates: [],
    paymentInserts: [],
    appointmentUpdates: [],
    notificationInserts: [],
    ...over,
  }
}

function fakeDb(state: FakeState): SupabaseClient {
  function chainFor(table: string) {
    const chain: Record<string, unknown> = {}
    const self = () => chain
    for (const m of ['select', 'eq', 'neq', 'in', 'order', 'limit']) {
      chain[m] = self
    }
    if (table === 'appointments') {
      chain.maybeSingle = () =>
        Promise.resolve({ data: state.appointment, error: null })
      chain.update = (payload: Record<string, unknown>) => {
        state.appointmentUpdates.push(payload)
        const upd: Record<string, unknown> = {}
        for (const m of ['eq', 'neq']) upd[m] = () => upd
        upd.select = () => Promise.resolve({ data: state.claimRows, error: null })
        return upd
      }
    } else if (table === 'payments') {
      chain.maybeSingle = () => Promise.resolve({ data: state.payment, error: null })
      chain.update = (payload: Record<string, unknown>) => {
        state.paymentUpdates.push(payload)
        const upd: Record<string, unknown> = {}
        upd.eq = () => upd
        upd.then = (resolve: (v: unknown) => void) =>
          resolve({ data: null, error: null })
        return upd
      }
      chain.insert = (payload: Record<string, unknown>) => {
        state.paymentInserts.push(payload)
        return Promise.resolve({ data: null, error: null })
      }
    } else if (table === 'contacts') {
      chain.maybeSingle = () => Promise.resolve({ data: state.contact, error: null })
    } else if (table === 'notifications') {
      chain.insert = (payload: Record<string, unknown>) => {
        state.notificationInserts.push(payload)
        return Promise.resolve({ data: null, error: null })
      }
    } else if (table === 'conversations') {
      chain.maybeSingle = () =>
        Promise.resolve({ data: state.fallbackConversation, error: null })
    }
    return chain
  }
  return { from: (table: string) => chainFor(table) } as unknown as SupabaseClient
}

const ARGS = { accountId: 'acc-1', appointmentId: 'appt-1', userId: 'user-1' }

beforeEach(() => {
  vi.clearAllMocks()
  h.sendMessageToConversation.mockResolvedValue({
    messageId: 'm1',
    whatsappMessageId: 'wa1',
  })
  h.advanceFunnelDeal.mockResolvedValue(undefined)
})

describe('confirmAppointmentDeposit — camino feliz', () => {
  it('confirma el pago prevalidado, sube la cita, avanza el embudo, notifica y avisa por WhatsApp', async () => {
    const state = makeState()
    const result = await confirmAppointmentDeposit(fakeDb(state), ARGS)

    expect(result).toEqual({
      ok: true,
      alreadyConfirmed: false,
      appointmentStatus: 'confirmada',
      whatsapp: 'sent',
    })
    // Pago prevalidado → confirmado, con auditoría de quién.
    expect(state.paymentUpdates).toHaveLength(1)
    expect(state.paymentUpdates[0]).toMatchObject({
      status: 'confirmado',
      confirmed_by: 'user-1',
    })
    // Cita: anticipo pagado + pendiente → confirmada.
    expect(state.appointmentUpdates[0]).toEqual({
      deposit_status: 'pagado',
      status: 'confirmada',
    })
    // Embudo IA → "Agendado".
    expect(h.advanceFunnelDeal).toHaveBeenCalledWith(
      expect.objectContaining({ contactId: 'contact-1', userId: 'user-1' }),
    )
    // Notificación interna del nuevo tipo.
    expect(state.notificationInserts[0]).toMatchObject({
      type: 'deposit_confirmed',
      title: 'Pago confirmado',
    })
    // WhatsApp a la conversación de la cita, con los datos reales.
    expect(h.sendMessageToConversation).toHaveBeenCalledTimes(1)
    const [, accountId, params] = h.sendMessageToConversation.mock.calls[0]
    expect(accountId).toBe('acc-1')
    expect(params.conversationId).toBe('conv-1')
    expect(params.contentText).toContain('Emiliano')
    expect(params.contentText).toContain('pago quedó confirmado')
    expect(params.contentText).toContain('Valoración general')
  })

  it('sin pago previo (pago en efectivo), crea el payment ya confirmado', async () => {
    const state = makeState({ payment: null })
    const result = await confirmAppointmentDeposit(fakeDb(state), ARGS)
    expect(result.ok).toBe(true)
    expect(state.paymentInserts).toHaveLength(1)
    expect(state.paymentInserts[0]).toMatchObject({
      status: 'confirmado',
      amount: 350,
      appointment_id: 'appt-1',
      confirmed_by: 'user-1',
    })
  })

  it('notify_patient=false confirma sin mandar WhatsApp', async () => {
    const state = makeState()
    const result = await confirmAppointmentDeposit(fakeDb(state), {
      ...ARGS,
      notifyPatient: false,
    })
    expect(result.whatsapp).toBe('skipped')
    expect(h.sendMessageToConversation).not.toHaveBeenCalled()
  })
})

describe('confirmAppointmentDeposit — carreras y degradados', () => {
  it('doble clic: el segundo pierde el claim y NO repite efectos', async () => {
    const state = makeState({ claimRows: [] })
    const result = await confirmAppointmentDeposit(fakeDb(state), ARGS)
    expect(result.alreadyConfirmed).toBe(true)
    expect(h.sendMessageToConversation).not.toHaveBeenCalled()
    expect(h.advanceFunnelDeal).not.toHaveBeenCalled()
    expect(state.notificationInserts).toHaveLength(0)
  })

  it('si el WhatsApp falla, la confirmación queda y el resultado lo dice', async () => {
    h.sendMessageToConversation.mockRejectedValue(new Error('zernio caído'))
    const state = makeState()
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const result = await confirmAppointmentDeposit(fakeDb(state), ARGS)
      expect(result.ok).toBe(true)
      expect(result.whatsapp).toBe('failed')
      expect(state.appointmentUpdates).toHaveLength(1)
    } finally {
      errSpy.mockRestore()
    }
  })

  it('cita sin conversación ligada usa la más reciente del contacto', async () => {
    const state = makeState({ fallbackConversation: { id: 'conv-9' } })
    ;(state.appointment as Record<string, unknown>).conversation_id = null
    const result = await confirmAppointmentDeposit(fakeDb(state), ARGS)
    expect(result.whatsapp).toBe('sent')
    const [, , params] = h.sendMessageToConversation.mock.calls[0]
    expect(params.conversationId).toBe('conv-9')
  })

  it('contacto sin conversación: confirma igual y reporta no_conversation', async () => {
    const state = makeState()
    ;(state.appointment as Record<string, unknown>).conversation_id = null
    const result = await confirmAppointmentDeposit(fakeDb(state), ARGS)
    expect(result.ok).toBe(true)
    expect(result.whatsapp).toBe('no_conversation')
  })
})

describe('confirmAppointmentDeposit — guardas', () => {
  it('cita inexistente → 404', async () => {
    const state = makeState({ appointment: null })
    await expect(confirmAppointmentDeposit(fakeDb(state), ARGS)).rejects.toThrowError(
      ConfirmDepositError,
    )
    await expect(
      confirmAppointmentDeposit(fakeDb(state), ARGS),
    ).rejects.toMatchObject({ status: 404 })
  })

  it('cita cancelada → 409, sin tocar nada', async () => {
    const state = makeState()
    ;(state.appointment as Record<string, unknown>).status = 'cancelada'
    await expect(
      confirmAppointmentDeposit(fakeDb(state), ARGS),
    ).rejects.toMatchObject({ status: 409 })
    expect(state.paymentUpdates).toHaveLength(0)
    expect(state.appointmentUpdates).toHaveLength(0)
  })

  it('cita sin anticipo requerido → 409', async () => {
    const state = makeState()
    ;(state.appointment as Record<string, unknown>).deposit_status = 'no_aplica'
    await expect(
      confirmAppointmentDeposit(fakeDb(state), ARGS),
    ).rejects.toMatchObject({ status: 409 })
  })
})

describe('buildConfirmationMessage', () => {
  it('arma el mensaje con nombre, servicio y horario local de la clínica', () => {
    const msg = buildConfirmationMessage({
      contactName: 'Emiliano',
      // 22:00Z = 4:00 p.m. en America/Mexico_City (offset fijo -06:00).
      startsAt: '2026-07-08T22:00:00Z',
      procedureName: 'Valoración general',
    })
    expect(msg).toContain('Emiliano, tu pago quedó confirmado')
    expect(msg).toContain('de Valoración general')
    expect(msg).toContain('4:00')
    expect(msg).toContain('escríbenos por aquí')
    // Estilo WhatsApp de la casa: sin signos de apertura.
    expect(msg).not.toContain('¡')
    expect(msg).not.toContain('¿')
  })

  it('sin nombre ni procedimiento sigue siendo natural', () => {
    const msg = buildConfirmationMessage({
      contactName: null,
      startsAt: '2026-07-08T22:00:00Z',
      procedureName: null,
    })
    expect(msg.startsWith('Tu pago quedó confirmado')).toBe(true)
  })
})
