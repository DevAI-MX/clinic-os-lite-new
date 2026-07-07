import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { buildConversationContext } from './context'

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
