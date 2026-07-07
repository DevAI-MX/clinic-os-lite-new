import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  analyzeReceiptImage,
  buildReceiptNote,
  buildRecentImageNotes,
  parseReceiptAnalysis,
} from './vision'

// ------------------------------------------------------------
// parseReceiptAnalysis
// ------------------------------------------------------------

describe('parseReceiptAnalysis', () => {
  it('parsea el JSON limpio del modelo', () => {
    const out = parseReceiptAnalysis(
      JSON.stringify({
        es_comprobante: true,
        monto: 350,
        moneda: 'MXN',
        fecha: '7 de julio 2026',
        banco: 'BBVA',
        referencia: 'MBAN0100',
        titular: 'Juan Pérez',
        descripcion: 'captura de transferencia SPEI',
      }),
    )
    expect(out).toEqual({
      esComprobante: true,
      monto: 350,
      moneda: 'MXN',
      fecha: '7 de julio 2026',
      banco: 'BBVA',
      referencia: 'MBAN0100',
      titular: 'Juan Pérez',
      descripcion: 'captura de transferencia SPEI',
    })
  })

  it('tolera fences de markdown y texto alrededor', () => {
    const raw =
      'Claro, aquí está:\n```json\n{"es_comprobante": false, "monto": null, "moneda": null, "fecha": null, "banco": null, "referencia": null, "titular": null, "descripcion": "selfie"}\n```'
    const out = parseReceiptAnalysis(raw)
    expect(out?.esComprobante).toBe(false)
    expect(out?.descripcion).toBe('selfie')
  })

  it('devuelve null con JSON malformado o sin objeto', () => {
    expect(parseReceiptAnalysis('no hay json')).toBeNull()
    expect(parseReceiptAnalysis('{monto: }')).toBeNull()
  })

  it('descarta montos no positivos o no numéricos', () => {
    const base = { es_comprobante: true, descripcion: 'x' }
    expect(parseReceiptAnalysis(JSON.stringify({ ...base, monto: 0 }))?.monto).toBeNull()
    expect(parseReceiptAnalysis(JSON.stringify({ ...base, monto: -5 }))?.monto).toBeNull()
    expect(
      parseReceiptAnalysis(JSON.stringify({ ...base, monto: 'abc' }))?.monto,
    ).toBeNull()
    // Un monto como string numérico sí se acepta (algunos modelos lo citan).
    expect(
      parseReceiptAnalysis(JSON.stringify({ ...base, monto: '350.00' }))?.monto,
    ).toBe(350)
  })

  it('es_comprobante solo es true con boolean true explícito', () => {
    expect(
      parseReceiptAnalysis('{"es_comprobante": "true", "descripcion": "x"}')
        ?.esComprobante,
    ).toBe(false)
  })
})

// ------------------------------------------------------------
// buildReceiptNote
// ------------------------------------------------------------

describe('buildReceiptNote', () => {
  it('arma la nota con los datos detectados', () => {
    const note = buildReceiptNote({
      esComprobante: true,
      monto: 350,
      moneda: 'MXN',
      fecha: '2026-07-07',
      banco: 'BBVA',
      referencia: 'ABC123',
      titular: 'Juan Pérez',
      descripcion: 'transferencia SPEI',
    })
    expect(note).toContain('[Nota automática del sistema')
    expect(note).toContain('Es comprobante de pago: sí')
    expect(note).toContain('Monto: 350 MXN')
    expect(note).toContain('Referencia/folio: ABC123')
  })

  it('omite las líneas de campos no detectados', () => {
    const note = buildReceiptNote({
      esComprobante: false,
      monto: null,
      moneda: null,
      fecha: null,
      banco: null,
      referencia: null,
      titular: null,
      descripcion: 'foto de una muela',
    })
    expect(note).toContain('Es comprobante de pago: no')
    expect(note).not.toContain('Monto:')
    expect(note).not.toContain('Referencia')
    expect(note).toContain('foto de una muela')
  })

  it('con análisis fallido deja la nota de imagen sin analizar', () => {
    const note = buildReceiptNote(null)
    expect(note).toContain('[Nota automática del sistema')
    expect(note).toContain('No se pudo analizar')
  })
})

// ------------------------------------------------------------
// analyzeReceiptImage — descarga + llamada de visión (fetch mockeado)
// ------------------------------------------------------------

const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
])

function imageResponse(opts: { contentType?: string | null; bytes?: Uint8Array } = {}) {
  const bytes = opts.bytes ?? PNG_BYTES
  return {
    ok: true,
    headers: {
      get: (k: string) =>
        k === 'content-type'
          ? (opts.contentType ?? 'image/png')
          : k === 'content-length'
            ? String(bytes.byteLength)
            : null,
    },
    arrayBuffer: async () => bytes.buffer.slice(0),
  }
}

const ANALYSIS_JSON =
  '{"es_comprobante": true, "monto": 350, "moneda": "MXN", "fecha": null, "banco": "BBVA", "referencia": "R1", "titular": null, "descripcion": "spei"}'

const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('analyzeReceiptImage', () => {
  it('OpenAI: descarga la imagen, la manda como data URL y parsea el JSON', async () => {
    fetchMock
      .mockResolvedValueOnce(imageResponse())
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ choices: [{ message: { content: ANALYSIS_JSON } }] }),
      })

    const out = await analyzeReceiptImage({
      provider: 'openai',
      apiKey: 'sk-test',
      model: 'o4-mini',
      imageUrl: 'https://cdn.zernio.test/comprobante.png',
    })

    expect(out?.esComprobante).toBe(true)
    expect(out?.monto).toBe(350)
    expect(out?.banco).toBe('BBVA')

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const [visionUrl, visionInit] = fetchMock.mock.calls[1]
    expect(visionUrl).toContain('api.openai.com')
    const body = JSON.parse(visionInit.body)
    expect(body.model).toBe('o4-mini')
    expect(JSON.stringify(body.messages)).toContain('data:image/png;base64,')
  })

  it('Anthropic: manda bloque de imagen base64 y junta los bloques de texto', async () => {
    fetchMock
      .mockResolvedValueOnce(imageResponse({ contentType: 'image/jpeg' }))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ content: [{ type: 'text', text: ANALYSIS_JSON }] }),
      })

    const out = await analyzeReceiptImage({
      provider: 'anthropic',
      apiKey: 'sk-ant',
      model: 'claude-test',
      imageUrl: 'https://cdn.zernio.test/comprobante.jpg',
    })

    expect(out?.referencia).toBe('R1')
    const [visionUrl, visionInit] = fetchMock.mock.calls[1]
    expect(visionUrl).toContain('api.anthropic.com')
    const body = JSON.parse(visionInit.body)
    expect(body.messages[0].content[0].source.media_type).toBe('image/jpeg')
  })

  it('detecta el media type por firma mágica cuando el CDN no manda Content-Type de imagen', async () => {
    fetchMock
      .mockResolvedValueOnce(imageResponse({ contentType: 'application/octet-stream' }))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ choices: [{ message: { content: ANALYSIS_JSON } }] }),
      })

    const out = await analyzeReceiptImage({
      provider: 'openai',
      apiKey: 'sk-test',
      model: 'o4-mini',
      imageUrl: 'https://cdn.zernio.test/sin-mime',
    })
    expect(out).not.toBeNull()
    const body = JSON.parse(fetchMock.mock.calls[1][1].body)
    expect(JSON.stringify(body.messages)).toContain('data:image/png;base64,')
  })

  it('devuelve null si la descarga falla y no llama al proveedor', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, headers: { get: () => null } })
    const out = await analyzeReceiptImage({
      provider: 'openai',
      apiKey: 'sk-test',
      model: 'o4-mini',
      imageUrl: 'https://cdn.zernio.test/caduco.jpg',
    })
    expect(out).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('devuelve null si el proveedor responde error (modelo sin visión, etc.)', async () => {
    fetchMock
      .mockResolvedValueOnce(imageResponse())
      .mockResolvedValueOnce({ ok: false, json: async () => ({}) })
    const out = await analyzeReceiptImage({
      provider: 'openai',
      apiKey: 'sk-test',
      model: 'texto-solo',
      imageUrl: 'https://cdn.zernio.test/c.png',
    })
    expect(out).toBeNull()
  })

  it('nunca lanza: un fetch que revienta devuelve null', async () => {
    fetchMock.mockRejectedValueOnce(new Error('boom'))
    const out = await analyzeReceiptImage({
      provider: 'openai',
      apiKey: 'sk-test',
      model: 'o4-mini',
      imageUrl: 'https://cdn.zernio.test/c.png',
    })
    expect(out).toBeNull()
  })
})

// ------------------------------------------------------------
// buildRecentImageNotes — wiring con la BD (fake mínimo)
// ------------------------------------------------------------

interface FakeDbOpts {
  lastReplyAt: string | null
  images: { media_url: string; created_at: string }[]
}

/** Distingue las dos queries por las columnas del select. */
function fakeDb(opts: FakeDbOpts): SupabaseClient {
  return {
    from: () => ({
      select: (cols: string) => {
        const chain = {
          eq: () => chain,
          in: () => chain,
          not: () => chain,
          gt: () => chain,
          order: () => chain,
          limit: (n: number) => {
            if (cols === 'created_at') {
              return {
                maybeSingle: () =>
                  Promise.resolve({
                    data: opts.lastReplyAt ? { created_at: opts.lastReplyAt } : null,
                    error: null,
                  }),
              }
            }
            return Promise.resolve({ data: opts.images.slice(0, n), error: null })
          },
        }
        return chain
      },
    }),
  } as unknown as SupabaseClient
}

describe('buildRecentImageNotes', () => {
  const NOW = new Date('2026-07-08T16:00:00Z')

  it('sin imágenes recientes devuelve [] sin llamar a visión', async () => {
    const notes = await buildRecentImageNotes({
      db: fakeDb({ lastReplyAt: null, images: [] }),
      conversationId: 'conv-1',
      provider: 'openai',
      apiKey: 'sk-test',
      model: 'o4-mini',
      now: NOW,
    })
    expect(notes).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('con imagen que no se puede analizar inyecta la nota de "sin analizar"', async () => {
    fetchMock.mockResolvedValue({ ok: false, headers: { get: () => null } })
    const notes = await buildRecentImageNotes({
      db: fakeDb({
        lastReplyAt: '2026-07-08T15:00:00Z',
        images: [
          { media_url: 'https://cdn.zernio.test/c.jpg', created_at: '2026-07-08T15:58:00Z' },
        ],
      }),
      conversationId: 'conv-1',
      provider: 'openai',
      apiKey: 'sk-test',
      model: 'o4-mini',
      now: NOW,
    })
    expect(notes).toHaveLength(1)
    expect(notes[0]).toContain('No se pudo analizar')
  })

  it('analiza en orden cronológico (la más vieja primero)', async () => {
    // Descarga + visión OK para ambas imágenes.
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('api.openai.com')) {
        return {
          ok: true,
          json: async () => ({ choices: [{ message: { content: ANALYSIS_JSON } }] }),
        }
      }
      return imageResponse()
    })
    const notes = await buildRecentImageNotes({
      db: fakeDb({
        lastReplyAt: null,
        // La query devuelve DESC (más nueva primero), como Supabase.
        images: [
          { media_url: 'https://cdn.zernio.test/b.png', created_at: '2026-07-08T15:59:00Z' },
          { media_url: 'https://cdn.zernio.test/a.png', created_at: '2026-07-08T15:58:00Z' },
        ],
      }),
      conversationId: 'conv-1',
      provider: 'openai',
      apiKey: 'sk-test',
      model: 'o4-mini',
      now: NOW,
    })
    expect(notes).toHaveLength(2)
    // Primera descarga = imagen más vieja (a.png).
    const downloadUrls = fetchMock.mock.calls
      .map((c) => c[0] as string)
      .filter((u) => u.includes('cdn.zernio.test'))
    expect(downloadUrls).toEqual([
      'https://cdn.zernio.test/a.png',
      'https://cdn.zernio.test/b.png',
    ])
  })

  it('nunca lanza: una BD rota devuelve []', async () => {
    const broken = {
      from: () => {
        throw new Error('db down')
      },
    } as unknown as SupabaseClient
    const notes = await buildRecentImageNotes({
      db: broken,
      conversationId: 'conv-1',
      provider: 'openai',
      apiKey: 'sk-test',
      model: 'o4-mini',
      now: NOW,
    })
    expect(notes).toEqual([])
  })
})
