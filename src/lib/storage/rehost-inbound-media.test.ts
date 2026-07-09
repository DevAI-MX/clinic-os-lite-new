import { describe, expect, it, vi, afterEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { rehostInboundMedia } from './rehost-inbound-media'

// JPEG: FF D8 + relleno hasta los 12 bytes que exige el sniffer.
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])
// Bytes sin firma reconocible.
const PLAIN_BYTES = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0, 0, 0, 0, 0, 0, 0, 0])
// MP4 (ISO base media): tamaño de caja + "ftyp" + brand "isom".
const MP4_BYTES = new Uint8Array([
  0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d,
])
// 3GP: mismo contenedor, brand "3gp5".
const THREE_GP_BYTES = new Uint8Array([
  0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x33, 0x67, 0x70, 0x35,
])

/** Respuesta mínima con la superficie que usa rehostInboundMedia —
 *  evita las semánticas de Response (p.ej. content-length calculado). */
function fakeResponse(args: {
  ok?: boolean
  bytes?: Uint8Array
  contentType?: string
  contentLength?: string
}) {
  const headers = new Headers()
  if (args.contentType) headers.set('content-type', args.contentType)
  if (args.contentLength) headers.set('content-length', args.contentLength)
  return {
    ok: args.ok ?? true,
    headers,
    arrayBuffer: async () => (args.bytes ?? JPEG_BYTES).buffer,
  }
}

function fakeDb(opts: { uploadError?: string } = {}) {
  const uploads: { path: string; options: Record<string, unknown> }[] = []
  const db = {
    storage: {
      from: () => ({
        upload: (path: string, _body: unknown, options: Record<string, unknown>) => {
          if (opts.uploadError) {
            return Promise.resolve({ error: { message: opts.uploadError } })
          }
          uploads.push({ path, options })
          return Promise.resolve({ error: null })
        },
        getPublicUrl: (path: string) => ({
          data: {
            publicUrl: `https://supa.example/storage/v1/object/public/chat-media/${path}`,
          },
        }),
      }),
    },
  } as unknown as SupabaseClient
  return { db, uploads }
}

// sleep sin espera real — los tests de reintento verifican el conteo
// de llamadas a fetch, no el paso del tiempo.
const noopSleep = async () => {}

const baseArgs = {
  accountId: 'acc-1',
  url: 'https://cdn.zernio.example/x',
  now: 123,
  sleep: noopSleep,
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('rehostInboundMedia', () => {
  it('sube la imagen con el mime olfateado y devuelve la URL pública', async () => {
    // El CDN declara octet-stream (caso típico) — manda la firma mágica.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        fakeResponse({ bytes: JPEG_BYTES, contentType: 'application/octet-stream' }),
      ),
    )
    const { db, uploads } = fakeDb()

    const url = await rehostInboundMedia({ db, ...baseArgs })

    expect(uploads).toHaveLength(1)
    expect(uploads[0].path).toMatch(/^account-acc-1\/123-inbound-[0-9a-f]{8}\.jpg$/)
    expect(uploads[0].options.contentType).toBe('image/jpeg')
    expect(url).toBe(
      `https://supa.example/storage/v1/object/public/chat-media/${uploads[0].path}`,
    )
  })

  it('olfatea video/mp4 por la caja ftyp cuando el CDN declara octet-stream', async () => {
    // Caso real: el CDN de Zernio/Meta suele declarar octet-stream para
    // video — sin este sniff el rehost fallaba en silencio y el panel
    // se quedaba con la URL efímera (recuadro gris tras expirar).
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        fakeResponse({ bytes: MP4_BYTES, contentType: 'application/octet-stream' }),
      ),
    )
    const { db, uploads } = fakeDb()

    const url = await rehostInboundMedia({ db, ...baseArgs })

    expect(uploads[0].path).toMatch(/\.mp4$/)
    expect(uploads[0].options.contentType).toBe('video/mp4')
    expect(url).not.toBeNull()
  })

  it('olfatea video/3gpp cuando el brand de la caja ftyp es 3gp', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        fakeResponse({ bytes: THREE_GP_BYTES, contentType: 'application/octet-stream' }),
      ),
    )
    const { db, uploads } = fakeDb()

    const url = await rehostInboundMedia({ db, ...baseArgs })

    expect(uploads[0].path).toMatch(/\.3gp$/)
    expect(uploads[0].options.contentType).toBe('video/3gpp')
    expect(url).not.toBeNull()
  })

  it('acepta un mime declarado del allow-list cuando no hay firma mágica', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => fakeResponse({ bytes: PLAIN_BYTES, contentType: 'audio/mpeg' })),
    )
    const { db, uploads } = fakeDb()

    const url = await rehostInboundMedia({ db, ...baseArgs })

    expect(uploads[0].path).toMatch(/\.mp3$/)
    expect(uploads[0].options.contentType).toBe('audio/mpeg')
    expect(url).not.toBeNull()
  })

  it('devuelve null sin subir cuando el mime no está en el allow-list del bucket', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => fakeResponse({ bytes: PLAIN_BYTES, contentType: 'image/tiff' })),
    )
    const { db, uploads } = fakeDb()

    expect(await rehostInboundMedia({ db, ...baseArgs })).toBeNull()
    expect(uploads).toHaveLength(0)
  })

  it('devuelve null cuando la descarga responde error en todos los intentos', async () => {
    const fetchMock = vi.fn(async () => fakeResponse({ ok: false }))
    vi.stubGlobal('fetch', fetchMock)
    const { db, uploads } = fakeDb()

    expect(await rehostInboundMedia({ db, ...baseArgs })).toBeNull()
    expect(uploads).toHaveLength(0)
    // 1 intento inicial + 2 reintentos (RETRY_DELAYS_MS).
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('reintenta cuando Zernio aún no cachea el archivo y sube en el intento que sí responde', async () => {
    let call = 0
    const fetchMock = vi.fn(async () => {
      call += 1
      // Los primeros 2 intentos fallan (CDN todavía no listo); el 3º sí.
      return call < 3 ? fakeResponse({ ok: false }) : fakeResponse({ bytes: JPEG_BYTES })
    })
    vi.stubGlobal('fetch', fetchMock)
    const sleepCalls: number[] = []
    const { db, uploads } = fakeDb()

    const url = await rehostInboundMedia({
      db,
      ...baseArgs,
      sleep: async (ms: number) => {
        sleepCalls.push(ms)
      },
    })

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(sleepCalls).toEqual([1_000, 2_000])
    expect(uploads).toHaveLength(1)
    expect(url).not.toBeNull()
  })

  it('devuelve null cuando el content-length declarado excede el tope', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        fakeResponse({ contentLength: String(17 * 1024 * 1024), contentType: 'image/jpeg' }),
      ),
    )
    const { db, uploads } = fakeDb()

    expect(await rehostInboundMedia({ db, ...baseArgs })).toBeNull()
    expect(uploads).toHaveLength(0)
  })

  it('devuelve null cuando el upload al bucket falla', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse({ bytes: JPEG_BYTES })))
    const { db } = fakeDb({ uploadError: 'bucket rejected' })

    expect(await rehostInboundMedia({ db, ...baseArgs })).toBeNull()
  })

  it('devuelve null (sin lanzar) cuando fetch revienta', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down')
      }),
    )
    const { db } = fakeDb()

    expect(await rehostInboundMedia({ db, ...baseArgs })).toBeNull()
  })
})
