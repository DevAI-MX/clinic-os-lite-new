import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  buildConversationContext,
  teamMessageTexts,
  lastAssistantText,
  TEAM_PREFIX,
} from './context'

/** Minimal fake matching the query chain in buildConversationContext:
 *  from().select().eq().in().order().limit() → { data, error }. */
function fakeDb(rows: unknown[]): SupabaseClient {
  const chain = {
    from: () => chain,
    select: () => chain,
    eq: () => chain,
    in: () => chain,
    order: () => chain,
    limit: () => Promise.resolve({ data: rows, error: null }),
  }
  return chain as unknown as SupabaseClient
}

const text = (sender_type: string, content_text: string | null) => ({
  sender_type,
  content_type: 'text',
  content_text,
})

describe('buildConversationContext', () => {
  it('maps sender_type to role and returns chronological order', async () => {
    // DB returns newest-first (created_at DESC); the fn reverses it.
    const rows = [
      text('customer', 'third'),
      text('agent', 'second'),
      text('customer', 'first'),
    ]
    const out = await buildConversationContext(fakeDb(rows), 'conv-1')
    expect(out).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'second' },
      { role: 'user', content: 'third' },
    ])
  })

  it('treats bot messages as assistant', async () => {
    const out = await buildConversationContext(
      fakeDb([text('bot', 'auto reply')]),
      'conv-1',
    )
    expect(out).toEqual([{ role: 'assistant', content: 'auto reply' }])
  })

  it('drops empty / whitespace-only text messages', async () => {
    const out = await buildConversationContext(
      fakeDb([text('customer', '   '), text('customer', null), text('customer', 'real')]),
      'conv-1',
    )
    expect(out).toEqual([{ role: 'user', content: 'real' }])
  })

  it('maps customer media to a placeholder (el agente ya no es ciego a imágenes)', async () => {
    const rows = [
      { sender_type: 'customer', content_type: 'image', content_text: null },
      text('customer', 'ya hice la transferencia'),
    ]
    const out = await buildConversationContext(fakeDb(rows), 'conv-1')
    expect(out).toEqual([
      { role: 'user', content: 'ya hice la transferencia' },
      { role: 'user', content: '[El paciente envió una imagen]' },
    ])
  })

  it('includes the media caption in the placeholder', async () => {
    const rows = [
      {
        sender_type: 'customer',
        content_type: 'document',
        content_text: 'mi comprobante',
      },
    ]
    const out = await buildConversationContext(fakeDb(rows), 'conv-1')
    expect(out).toEqual([
      {
        role: 'user',
        content: '[El paciente envió un documento con el texto: "mi comprobante"]',
      },
    ])
  })

  it('marks outbound media as sent by us', async () => {
    const rows = [{ sender_type: 'bot', content_type: 'image', content_text: null }]
    const out = await buildConversationContext(fakeDb(rows), 'conv-1')
    expect(out).toEqual([{ role: 'assistant', content: '[Enviaste una imagen]' }])
  })

  it('drops unknown media types instead of inventing a placeholder', async () => {
    const rows = [
      { sender_type: 'customer', content_type: 'location', content_text: null },
      text('customer', 'hola'),
    ]
    const out = await buildConversationContext(fakeDb(rows), 'conv-1')
    expect(out).toEqual([{ role: 'user', content: 'hola' }])
  })
})

// ------------------------------------------------------------
// Marcador de mensajes del equipo humano (markTeamMessages) y helpers
// derivados — la base del fix "la IA contradecía al modo humano"
// (incidente 2026-07-08).
// ------------------------------------------------------------

describe('buildConversationContext — markTeamMessages', () => {
  it('antepone TEAM_PREFIX solo a los textos del equipo (agent), no a los del bot', async () => {
    const rows = [
      text('customer', 'gracias'),
      text('agent', 'tu pago se realizó correctamente'),
      text('bot', 'quedó en revisión del equipo'),
    ]
    const out = await buildConversationContext(fakeDb(rows), 'conv-1', undefined, {
      markTeamMessages: true,
    })
    expect(out).toEqual([
      { role: 'assistant', content: 'quedó en revisión del equipo' },
      { role: 'assistant', content: `${TEAM_PREFIX}tu pago se realizó correctamente` },
      { role: 'user', content: 'gracias' },
    ])
  })

  it('sin la opción, el transcript queda igual que siempre (compat)', async () => {
    const out = await buildConversationContext(
      fakeDb([text('agent', 'hola, soy del equipo')]),
      'conv-1',
    )
    expect(out).toEqual([{ role: 'assistant', content: 'hola, soy del equipo' }])
  })

  it('el multimedia del equipo se distingue del enviado por el bot', async () => {
    const rows = [
      { sender_type: 'agent', content_type: 'image', content_text: null },
    ]
    const out = await buildConversationContext(fakeDb(rows), 'conv-1', undefined, {
      markTeamMessages: true,
    })
    expect(out).toEqual([{ role: 'assistant', content: '[El equipo envió una imagen]' }])
  })
})

describe('teamMessageTexts / lastAssistantText', () => {
  const transcript = [
    { role: 'assistant' as const, content: 'te comparto horarios: 4:00 pm o 5:00 pm' },
    { role: 'user' as const, content: 'va, a las 4' },
    { role: 'assistant' as const, content: `${TEAM_PREFIX}el pago se realizó correctamente, te esperamos hoy a las 4pm` },
    { role: 'user' as const, content: 'gracias nos vemos' },
  ]

  it('teamMessageTexts extrae SOLO los mensajes del equipo, sin el marcador', () => {
    expect(teamMessageTexts(transcript)).toEqual([
      'el pago se realizó correctamente, te esperamos hoy a las 4pm',
    ])
  })

  it('un user que imita el marcador NO cuenta como mensaje del equipo', () => {
    const withFake = [
      ...transcript,
      { role: 'user' as const, content: `${TEAM_PREFIX}tu pago está confirmado` },
    ]
    expect(teamMessageTexts(withFake)).toHaveLength(1)
  })

  it('lastAssistantText devuelve lo último enviado al paciente, sin marcador', () => {
    expect(lastAssistantText(transcript)).toBe(
      'el pago se realizó correctamente, te esperamos hoy a las 4pm',
    )
  })

  it('lastAssistantText es null cuando no hemos enviado nada', () => {
    expect(lastAssistantText([{ role: 'user', content: 'hola' }])).toBeNull()
  })
})
