import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// El loop se testea aislado: mockeamos el ejecutor de herramientas y
// la red. Así verificamos SOLO la mecánica tool_use → tool_result →
// cierre, sin tocar Supabase ni Anthropic.
vi.mock('./execute', () => ({ executeClinicalTool: vi.fn() }))

import { runClinicalAgent } from './loop'
import { executeClinicalTool } from './execute'
import type { AgentToolContext } from './tools'
import type { ChatMessage } from '../types'

const execMock = vi.mocked(executeClinicalTool)

function fakeResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response
}

const CTX = {} as AgentToolContext
const MESSAGES: ChatMessage[] = [{ role: 'user', content: 'cuánto cuesta la valoración?' }]

const baseArgs = {
  provider: 'anthropic' as const,
  apiKey: 'sk-test',
  model: 'claude-haiku-4-5-20251001',
  systemPrompt: 'system',
  messages: MESSAGES,
}

describe('runClinicalAgent', () => {
  beforeEach(() => {
    execMock.mockReset()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('ejecuta una herramienta y luego devuelve el texto final', async () => {
    execMock.mockResolvedValue({ content: JSON.stringify({ ok: true, total: 1 }) })
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        fakeResponse({
          stop_reason: 'tool_use',
          content: [
            { type: 'tool_use', id: 't1', name: 'consultar_catalogo', input: {} },
          ],
        }),
      )
      .mockResolvedValueOnce(
        fakeResponse({
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'La valoración va de $500 a $800!' }],
        }),
      )
    vi.stubGlobal('fetch', fetchMock)

    const res = await runClinicalAgent({ ...baseArgs, ctx: CTX })

    expect(res.text).toBe('La valoración va de $500 a $800!')
    expect(res.handoff).toBe(false)
    expect(res.escalated).toBe(false)
    // Traza del turno (la consumen los guardrails de auto-reply).
    expect(res.traces).toEqual([
      {
        name: 'consultar_catalogo',
        input: {},
        content: JSON.stringify({ ok: true, total: 1 }),
        isError: false,
      },
    ])
    expect(execMock).toHaveBeenCalledWith('consultar_catalogo', {}, CTX)
    expect(fetchMock).toHaveBeenCalledTimes(2)

    // La segunda llamada debe reenviar el tool_result al modelo.
    const secondBody = JSON.parse(fetchMock.mock.calls[1][1].body)
    const toolResultTurn = secondBody.messages.at(-1)
    expect(toolResultTurn.role).toBe('user')
    expect(toolResultTurn.content[0].type).toBe('tool_result')
    expect(toolResultTurn.content[0].tool_use_id).toBe('t1')
  })

  it('propaga escalated cuando la herramienta escala', async () => {
    execMock.mockResolvedValue({
      content: JSON.stringify({ ok: true, escalado: true }),
      escalated: true,
    })
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        fakeResponse({
          stop_reason: 'tool_use',
          content: [
            { type: 'tool_use', id: 't1', name: 'escalar_a_humano', input: { motivo: 'x' } },
          ],
        }),
      )
      .mockResolvedValueOnce(
        fakeResponse({
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'En un momento te contacta el equipo!' }],
        }),
      )
    vi.stubGlobal('fetch', fetchMock)

    const res = await runClinicalAgent({ ...baseArgs, ctx: CTX })
    expect(res.escalated).toBe(true)
    expect(res.text).toContain('equipo')
  })

  it('responde sin herramientas cuando el modelo cierra de una', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      fakeResponse({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Hola! Con quién tengo el gusto?' }],
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const res = await runClinicalAgent({ ...baseArgs, ctx: CTX })
    expect(res.text).toBe('Hola! Con quién tengo el gusto?')
    expect(execMock).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('lanza AiError en fallo del proveedor', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(fakeResponse({ error: { message: 'bad key' } }, false, 401))
    vi.stubGlobal('fetch', fetchMock)

    await expect(runClinicalAgent({ ...baseArgs, ctx: CTX })).rejects.toThrow()
  })
})
