import { describe, it, expect, vi, afterEach } from 'vitest'

import { runExternalAgent } from './loop-external'
import { runClinicalAgent } from './loop'
import type { AgentToolContext, RunClinicalAgentArgs } from './tools'
import type { ChatMessage } from '../types'

function fakeResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: () => Promise.resolve(body) } as unknown as Response
}
const chat = (content: string | null) =>
  fakeResponse({ choices: [{ message: { content } }] })

const CTX = {} as AgentToolContext
const MESSAGES: ChatMessage[] = [{ role: 'user', content: 'hola' }]

function args(over: Partial<RunClinicalAgentArgs> = {}): RunClinicalAgentArgs {
  return {
    provider: 'openai',
    apiKey: 'sk-native',
    model: 'openclaw/coco',
    systemPrompt: 'system',
    messages: MESSAGES,
    ctx: CTX,
    backend: 'openclaw',
    baseUrl: 'http://openclaw:18789/v1',
    authToken: 'gw-token',
    ...over,
  }
}

describe('runExternalAgent (adaptador OpenAI-compat brain-only)', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('POSTea a <baseUrl>/chat/completions con model+messages+auth y devuelve el texto', async () => {
    const fetchMock = vi.fn().mockResolvedValue(chat('Todo bien'))
    vi.stubGlobal('fetch', fetchMock)

    const res = await runExternalAgent(args())

    expect(res).toEqual({ text: 'Todo bien', handoff: false, escalated: false, traces: [] })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://openclaw:18789/v1/chat/completions')
    const body = JSON.parse(init.body as string)
    expect(body.model).toBe('openclaw/coco')
    expect(body.messages[0]).toEqual({ role: 'system', content: 'system' })
    expect(body.messages.at(-1)).toEqual({ role: 'user', content: 'hola' })
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer gw-token')
  })

  it('parsea el centinela de handoff (mismo contrato que los loops nativos)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(chat('Te paso con un humano [[HANDOFF]]')))
    const res = await runExternalAgent(args())
    expect(res.handoff).toBe(true)
    expect(res.text).toBe('Te paso con un humano')
  })

  it('sin baseUrl → handoff sin llamar al gateway', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const res = await runExternalAgent(args({ baseUrl: undefined }))
    expect(res).toEqual({ text: '', handoff: true, escalated: false, traces: [] })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('sin authToken → sin header Authorization', async () => {
    const fetchMock = vi.fn().mockResolvedValue(chat('ok'))
    vi.stubGlobal('fetch', fetchMock)
    await runExternalAgent(args({ authToken: undefined }))
    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined()
  })

  it('error HTTP del gateway → lanza (auto-reply.ts lo captura)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeResponse({ error: 'x' }, false, 502)))
    await expect(runExternalAgent(args())).rejects.toThrow()
  })
})

describe('runClinicalAgent (dispatcher por backend)', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('backend openclaw → pega al gateway externo, no a OpenAI', async () => {
    const fetchMock = vi.fn().mockResolvedValue(chat('externo'))
    vi.stubGlobal('fetch', fetchMock)
    const res = await runClinicalAgent(args({ backend: 'openclaw' }))
    expect(res.text).toBe('externo')
    expect(fetchMock.mock.calls[0][0]).toBe('http://openclaw:18789/v1/chat/completions')
  })

  it('backend ausente + provider openai → path NATIVO (api.openai.com)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        fakeResponse({ choices: [{ finish_reason: 'stop', message: { content: 'nativo' } }] }),
      )
    vi.stubGlobal('fetch', fetchMock)
    const res = await runClinicalAgent(args({ backend: undefined }))
    expect(res.text).toBe('nativo')
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.openai.com/v1/chat/completions')
  })
})
