import { describe, it, expect } from 'vitest'
import { parseAttachments, buildAttachmentNote } from './attachments'

// ------------------------------------------------------------
// La validación de adjuntos es la frontera de seguridad: el server
// descarga estas URLs para visión, así que TODO lo que no sea nuestro
// bucket público debe rebotar (SSRF). Las notas son la interfaz con el
// modelo — puras y verificables sin red.
// ------------------------------------------------------------

const BASE = 'https://proj.supabase.co/storage/v1/object/public/chat-media/'

const img = (over: Partial<{ url: string; mime: string; name: string }> = {}) => ({
  url: `${BASE}account-acc-1/123-recibo.jpg`,
  mime: 'image/jpeg',
  name: 'recibo.jpg',
  ...over,
})

describe('parseAttachments', () => {
  it('acepta referencias válidas de nuestro bucket', () => {
    const out = parseAttachments([img()], BASE)
    expect(out).toHaveLength(1)
    expect(out![0].name).toBe('recibo.jpg')
  })

  it('sin adjuntos (null/undefined) → lista vacía, no error', () => {
    expect(parseAttachments(undefined, BASE)).toEqual([])
    expect(parseAttachments(null, BASE)).toEqual([])
  })

  it('rechaza URLs fuera del bucket (SSRF)', () => {
    expect(
      parseAttachments([img({ url: 'https://evil.com/x.jpg' })], BASE),
    ).toBeNull()
    expect(
      parseAttachments(
        [img({ url: 'https://proj.supabase.co/storage/v1/object/public/otro-bucket/x.jpg' })],
        BASE,
      ),
    ).toBeNull()
  })

  it('rechaza mimes fuera de la allow-list', () => {
    expect(parseAttachments([img({ mime: 'image/svg+xml' })], BASE)).toBeNull()
    expect(parseAttachments([img({ mime: 'text/html' })], BASE)).toBeNull()
  })

  it('rechaza más de 3 adjuntos', () => {
    expect(parseAttachments([img(), img(), img(), img()], BASE)).toBeNull()
  })

  it('sin storageBase (env ausente) nada pasa', () => {
    expect(parseAttachments([img()], '')).toBeNull()
  })

  it('nombre vacío cae a "archivo" y se recorta el resto', () => {
    const out = parseAttachments([img({ name: '' })], BASE)
    expect(out![0].name).toBe('archivo')
  })
})

describe('buildAttachmentNote', () => {
  it('PDF → nota de contenido no legible con el nombre', () => {
    const note = buildAttachmentNote(
      { url: `${BASE}x.pdf`, mime: 'application/pdf', name: 'estudio.pdf' },
      null,
    )
    expect(note).toContain('estudio.pdf')
    expect(note).toContain('No puedes leer su contenido')
  })

  it('imagen sin análisis → nota degradada (el turno sigue)', () => {
    const note = buildAttachmentNote(img(), null)
    expect(note).toContain('recibo.jpg')
    expect(note).toContain('No se pudo analizar')
  })

  it('imagen comprobante → monto, banco y referencia para el modelo', () => {
    const note = buildAttachmentNote(img(), {
      esComprobante: true,
      monto: 350,
      moneda: 'MXN',
      fecha: '07/07/2026',
      banco: 'BBVA',
      referencia: 'ABC123',
      titular: 'Juan Pérez',
      descripcion: 'Captura de transferencia SPEI',
    })
    expect(note).toContain('Es comprobante de pago: sí')
    expect(note).toContain('Monto: 350 MXN')
    expect(note).toContain('Banco emisor: BBVA')
    expect(note).toContain('Referencia/folio: ABC123')
  })
})
