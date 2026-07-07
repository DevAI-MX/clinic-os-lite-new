import { describe, it, expect } from 'vitest'
import { pickVoiceApiKey, prepareTtsText, TTS_MAX_CHARS } from './voice'

// ------------------------------------------------------------
// La voz siempre corre sobre OpenAI: la resolución de la key y la
// preparación del texto (lo que realmente se manda a sintetizar) son
// las dos piezas puras que vale la pena clavar con tests.
// ------------------------------------------------------------

describe('pickVoiceApiKey', () => {
  it('proveedor OpenAI → usa la key del agente', () => {
    expect(
      pickVoiceApiKey({ provider: 'openai', apiKey: 'sk-chat', embeddingsApiKey: 'sk-emb' }),
    ).toBe('sk-chat')
  })

  it('proveedor Anthropic → cae a la key de embeddings (siempre OpenAI)', () => {
    expect(
      pickVoiceApiKey({ provider: 'anthropic', apiKey: 'sk-ant', embeddingsApiKey: 'sk-emb' }),
    ).toBe('sk-emb')
  })

  it('Anthropic sin embeddings → null (voz no disponible)', () => {
    expect(
      pickVoiceApiKey({ provider: 'anthropic', apiKey: 'sk-ant', embeddingsApiKey: null }),
    ).toBeNull()
  })
})

describe('prepareTtsText', () => {
  it('quita markdown que sonaría mal leído', () => {
    expect(prepareTtsText('**Hola** doctor, revisa `payments` y [el panel](https://x.com).')).toBe(
      'Hola doctor, revisa payments y el panel.',
    )
  })

  it('quita bullets de lista', () => {
    expect(prepareTtsText('- uno\n- dos')).toBe('uno\ndos')
  })

  it('texto largo se corta en frontera de oración bajo el tope', () => {
    const sentence = 'Esta es una oración de prueba para el tope. '
    const long = sentence.repeat(200)
    const out = prepareTtsText(long)
    expect(out.length).toBeLessThanOrEqual(TTS_MAX_CHARS)
    expect(out.endsWith('.')).toBe(true)
  })

  it('vacío → vacío (el route responde 400)', () => {
    expect(prepareTtsText('   ')).toBe('')
  })
})
