import { describe, it, expect } from 'vitest'
import { buildClinicalSystemPrompt } from './prompt'

const BASE = {
  userPrompt: null,
  contactName: 'Laura',
  timezone: 'America/Mexico_City',
  now: new Date('2026-07-08T16:00:00Z'),
}

describe('buildClinicalSystemPrompt — multi-step', () => {
  it('incluye la planeación interna silenciosa (sin exponer razonamiento)', () => {
    const prompt = buildClinicalSystemPrompt(BASE)
    expect(prompt).toContain('# Planeación interna (silenciosa)')
    expect(prompt).toContain('EN SILENCIO')
    expect(prompt).toContain('No reveles ni narres ese plan')
  })

  it('incluye las reglas de identidad y datos sensibles (no recitar expediente)', () => {
    const prompt = buildClinicalSystemPrompt(BASE)
    expect(prompt).toContain('# Identidad y datos sensibles')
    expect(prompt).toContain('NUNCA recites el expediente completo')
    expect(prompt).toContain('confirma su identidad')
  })

  it('con flowLines pinta la sección de progreso con sus reglas de flujo', () => {
    const prompt = buildClinicalSystemPrompt({
      ...BASE,
      flowLines: [
        '1. Servicio: confirmado en el sistema — "Valoración".',
        '2. Cita: apartada en el sistema para mié 8 jul, 16:30 (pendiente de que el equipo la confirme).',
      ],
    })
    expect(prompt).toContain('# Progreso del flujo de recepción')
    expect(prompt).toContain('- 1. Servicio: confirmado en el sistema — "Valoración".')
    expect(prompt).toContain('NO repitas ni vuelvas a pedir un paso ya completo')
    expect(prompt).toContain('NUNCA te saltes el anticipo')
    expect(prompt).toContain('agendar_cita va EN ESTE mismo turno')
  })

  it('sin flowLines la sección de progreso no aparece', () => {
    const prompt = buildClinicalSystemPrompt(BASE)
    expect(prompt).not.toContain('# Progreso del flujo de recepción')
  })
})
