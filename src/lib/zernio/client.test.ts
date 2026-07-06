import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  extractZernioMessageId,
  toZernioPhone,
  zernioSendMedia,
  zernioSendTemplate,
  zernioSendText,
} from './client'

// The base URL is NEVER assumed in these tests (it isn't confirmed in
// Zernio's docs) — every test pins ZERNIO_BASE_URL explicitly.
const BASE = 'https://zernio.test/api'

interface Captured {
  url: string
  method: string
  headers: Record<string, string>
  body: Record<string, unknown>
}

function stubFetchOk(responseBody: unknown): { captured: () => Captured } {
  let captured: Captured | null = null
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      captured = {
        url,
        method: init.method ?? 'GET',
        headers: (init.headers ?? {}) as Record<string, string>,
        body: JSON.parse(String(init.body)),
      }
      return new Response(JSON.stringify(responseBody), { status: 200 })
    }),
  )
  return {
    captured: () => {
      if (!captured) throw new Error('fetch was never called')
      return captured
    },
  }
}

beforeEach(() => {
  vi.stubEnv('ZERNIO_API_KEY', 'zk_test_123')
  vi.stubEnv('ZERNIO_ACCOUNT_ID', 'acc_42')
  vi.stubEnv('ZERNIO_BASE_URL', BASE)
  vi.stubEnv('ZERNIO_DRY_RUN', '')
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('zernioSendText', () => {
  it('POSTs to /v1/accounts/{accountId}/whatsapp/messages with Bearer auth', async () => {
    const fetchSpy = stubFetchOk({ message: { platformMessageId: 'wamid.Z1', id: 'zm_1' } })

    const result = await zernioSendText({ to: '5215512345678', text: 'Hola' })

    const call = fetchSpy.captured()
    expect(call.url).toBe(`${BASE}/v1/accounts/acc_42/whatsapp/messages`)
    expect(call.method).toBe('POST')
    expect(call.headers.Authorization).toBe('Bearer zk_test_123')
    expect(call.body).toEqual({
      to: '+5215512345678',
      messageType: 'text',
      text: 'Hola',
    })
    // Prefers the wamid over Zernio's internal id.
    expect(result).toEqual({ messageId: 'wamid.Z1' })
  })

  it('accepts already-prefixed +E.164 recipients without double-prefixing', async () => {
    const fetchSpy = stubFetchOk({ id: 'zm_2' })
    await zernioSendText({ to: '+34 600 111 222', text: 'Hola' })
    expect(fetchSpy.captured().body.to).toBe('+34600111222')
  })

  it('throws the API error message on a non-2xx response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { message: 'Account not connected' } }), {
            status: 422,
          }),
      ),
    )
    await expect(zernioSendText({ to: '521555', text: 'x' })).rejects.toThrow(
      'Account not connected',
    )
  })

  it('falls back to a status-based error when the body is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })))
    await expect(zernioSendText({ to: '521555', text: 'x' })).rejects.toThrow(
      'Zernio API error: 500',
    )
  })

  it('throws when the response carries no message id', async () => {
    stubFetchOk({ ok: true })
    await expect(zernioSendText({ to: '521555', text: 'x' })).rejects.toThrow(
      /returned no message id/,
    )
  })
})

describe('zernioSendMedia', () => {
  it('maps mediaType, url and caption into the media object', async () => {
    const fetchSpy = stubFetchOk({ message: { id: 'zm_3' } })

    const result = await zernioSendMedia({
      to: '5215512345678',
      mediaType: 'image',
      url: 'https://cdn.example.test/foto.jpg',
      caption: 'La foto',
    })

    expect(fetchSpy.captured().body).toEqual({
      to: '+5215512345678',
      messageType: 'media',
      media: {
        mediaType: 'image',
        url: 'https://cdn.example.test/foto.jpg',
        caption: 'La foto',
      },
    })
    expect(result).toEqual({ messageId: 'zm_3' })
  })

  it('drops the caption for audio (WhatsApp rejects audio captions)', async () => {
    const fetchSpy = stubFetchOk({ message: { id: 'zm_4' } })
    await zernioSendMedia({
      to: '521555',
      mediaType: 'audio',
      url: 'https://cdn.example.test/nota.ogg',
      caption: 'ignored',
    })
    expect(fetchSpy.captured().body.media).toEqual({
      mediaType: 'audio',
      url: 'https://cdn.example.test/nota.ogg',
    })
  })

  it('requires a url before any network call', async () => {
    vi.stubGlobal('fetch', vi.fn())
    await expect(
      zernioSendMedia({ to: '521555', mediaType: 'image', url: '' }),
    ).rejects.toThrow(/requires a url/)
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('zernioSendTemplate', () => {
  it('sends name, language and variableMapping', async () => {
    const fetchSpy = stubFetchOk({ message: { platformMessageId: 'wamid.T1' } })

    await zernioSendTemplate({
      to: '5215512345678',
      name: 'recordatorio_cita',
      language: 'es_MX',
      variableMapping: { '1': 'Emiliano', '2': 'lunes 10am' },
    })

    expect(fetchSpy.captured().body).toEqual({
      to: '+5215512345678',
      messageType: 'template',
      template: {
        name: 'recordatorio_cita',
        language: 'es_MX',
        variableMapping: { '1': 'Emiliano', '2': 'lunes 10am' },
      },
    })
  })

  it('omits an empty variableMapping', async () => {
    const fetchSpy = stubFetchOk({ message: { id: 'zm_5' } })
    await zernioSendTemplate({ to: '521555', name: 'hola', language: 'es_MX' })
    expect(fetchSpy.captured().body.template).toEqual({
      name: 'hola',
      language: 'es_MX',
    })
  })
})

describe('dry run (ZERNIO_DRY_RUN=true, no API key)', () => {
  it('returns a synthetic id without touching the network', async () => {
    vi.stubEnv('ZERNIO_API_KEY', '')
    vi.stubEnv('ZERNIO_DRY_RUN', 'true')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const result = await zernioSendText({ to: '521555', text: 'hola dev' })

    expect(result.messageId).toMatch(/^zernio-dry-run-/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('still uses the real API when a key is present alongside the flag', async () => {
    vi.stubEnv('ZERNIO_DRY_RUN', 'true') // key wins — dry run is the no-creds path
    const fetchSpy = stubFetchOk({ message: { id: 'zm_6' } })
    const result = await zernioSendText({ to: '521555', text: 'x' })
    expect(result).toEqual({ messageId: 'zm_6' })
    expect(fetchSpy.captured().url).toContain('/whatsapp/messages')
  })
})

describe('helpers', () => {
  it('toZernioPhone strips formatting and adds the + prefix', () => {
    expect(toZernioPhone('52 (155) 1234-5678')).toBe('+5215512345678')
    expect(toZernioPhone('+34600111222')).toBe('+34600111222')
  })

  it('extractZernioMessageId walks the tolerant shapes in priority order', () => {
    expect(
      extractZernioMessageId({ message: { platformMessageId: 'wamid.A', id: 'z1' } }),
    ).toBe('wamid.A')
    expect(extractZernioMessageId({ message: { id: 'z1' } })).toBe('z1')
    expect(extractZernioMessageId({ messageId: 'z2' })).toBe('z2')
    expect(extractZernioMessageId({ id: 'z3' })).toBe('z3')
    expect(extractZernioMessageId({})).toBeNull()
    expect(extractZernioMessageId(null)).toBeNull()
  })
})
