# clinicOS — Agente Concierge: diseño de UI y arquitectura frontend

> Documento de diseño. Basado en exploración real del repo (`clinicOS0.3`, Next.js 16 + Supabase + Tailwind v4 + shadcn/ui sobre Base UI). Acompañado del mockup `concierge-mockup.html`.

---

## 1. Resumen ejecutivo

El **Concierge** es la evolución del "Internal assistant" (hoy un tab escondido en `/agents`, solo lectura, stateless) a la **pieza central del panel**: un chat estilo LLM moderno donde el doctor/equipo consulta la operación **y ejecuta acciones** (validar anticipos, confirmar/mover citas, mover deals, crear notas) con un patrón estricto de **acción propuesta → confirmación explícita en la UI → ejecución**. El servidor **nunca** ejecuta una mutación sin el clic de "Confirmar" del usuario — así la regla de oro del producto ("pagos y citas los decide un humano") se conserva: el humano es el usuario del chat y su confirmación es el acto humano.

Decisiones clave:

| Tema | Decisión |
|---|---|
| Ubicación | Página dedicada **`/concierge`**, primer ítem del sidebar (Fase 1). Acceso global con panel lateral (`Sheet`) reutilizando los mismos componentes (Fase 3). |
| Confirmación | Tools de lectura ejecutan directo; tools de escritura crean una fila en `assistant_actions` (estado `proposed`) y la UI pinta una **Action Card**. Confirmar = `POST /api/ai/concierge/actions/[id]/confirm`. Token de acción = el UUID de la fila, de un solo uso. |
| Streaming | **Fetch streaming** (POST + `ReadableStream` con eventos NDJSON) desde un route handler — verificado en docs de Next 16 (`route.md` § Streaming). No EventSource (solo soporta GET). |
| Voz | STT: **OpenAI `gpt-4o-mini-transcribe`** (grabación con `MediaRecorder`). TTS: **OpenAI `gpt-4o-mini-tts`**. Fallback: Web Speech API. |
| Persistencia | 3 tablas nuevas: `assistant_sessions`, `assistant_messages`, `assistant_actions` (migración `043_concierge.sql`), RLS por `is_account_member`. |
| Fases | F1 texto + acciones con confirmación · F2 voz + adjuntos · F3 proactividad + acceso global. |

---

## 2. Lo que ya existe (verificado en el repo)

### 2.1 Design tokens reales (`src/app/globals.css`)

El theming tiene **dos dimensiones ortogonales** en `<html>`: `data-mode` (light/dark, superficies neutras) y `data-theme` (acento; default `petroleo`). **El default del panel es LIGHT ("porcelana")** — verificado en `src/lib/themes.ts` (`DEFAULT_MODE: Mode = "light"`) y en el boot script de `src/app/layout.tsx`. (La suposición "dark por defecto" era del wacrm viejo; clinicOS 0.3 la invirtió.)

Tokens copiados al mockup (oklch):

- **Light (porcelana):** `--background: oklch(0.977 0.0035 85)` · `--foreground: oklch(0.24 0.012 75)` · `--card: oklch(0.995 0.002 90)` · `--card-2: oklch(0.982 0.003 87)` · `--muted: oklch(0.945 0.0055 85)` · `--muted-foreground: oklch(0.5 0.012 75)` · `--border: oklch(0.908 0.006 85)` · `--sidebar: oklch(0.963 0.004 85)` · `--success: oklch(0.55 0.1 155)` · `--warning: oklch(0.72 0.13 75)` · `--destructive: oklch(0.55 0.17 26)`
- **Dark (grafito):** `--background: oklch(0.185 0.006 75)` · `--card: oklch(0.223 0.007 75)` · `--card-2: oklch(0.245 0.007 75)` · `--foreground: oklch(0.93 0.005 85)` · `--muted: oklch(0.262 0.008 75)` · `--muted-foreground: oklch(0.66 0.01 80)` · `--border: oklch(1 0 0 / 9%)` · `--sidebar: oklch(0.165 0.006 75)` · `--success: oklch(0.68 0.1 155)`
- **Acento petróleo:** light `--primary: oklch(0.45 0.078 218)`; en dark sube a `oklch(0.72 0.082 205)` (con `--primary-foreground` oscuro). `--primary-soft = primary/0.12`.
- **Radius:** base `--radius: 0.625rem`; `sm=0.6×`, `md=0.8×`, `lg=1×`, `xl=1.4×`, `2xl=1.8×`.
- **Sombras:** `--shadow-soft` (toda tarjeta), `--shadow-lifted` (hover), `--shadow-floating` (popovers/paneles).
- **Tipografía:** Geist (`--font-sans`), Geist Mono; `tracking-tight` en headings; utilidad `.nums` (tabular-nums) para montos/horas; `.interactive` = transición 200ms ease-out.
- **Animaciones propias:** `--animate-fade-up` (0.35s), `--animate-fade-in`, `--animate-pulse-dot`.

### 2.2 El asistente interno actual (punto de partida)

- **UI:** `src/components/agents/internal-assistant-chat.tsx` — chat mínimo (burbujas, textarea, Enter para enviar), montado como tab en `src/app/(dashboard)/agents/page.tsx`. Sin sesiones, sin streaming, sin markdown, sin resultados estructurados.
- **API:** `src/app/api/ai/internal-assistant/route.ts` — `requireRole('agent')`, rate limit, `loadAiConfig` (BYO key: `provider ∈ {anthropic, openai}` + `model` + `embeddings_api_key` opcional, siempre OpenAI), **stateless** (el cliente reenvía todo el transcript), responde `{ reply }` en JSON de un golpe.
- **Tools solo lectura** (`src/lib/ai/internal/tools.ts` + `execute.ts`): `consultar_agenda_dia`, `consultar_anticipos_pendientes`, `consultar_embudo`, `buscar_paciente`. Corren con el **cliente del usuario logueado (RLS activo)**, filtrando además por `account_id`.
- **Prompt fijo** (`internal/prompt.ts`): hoy dice explícitamente "eres SOLO CONSULTA… diles que lo hagan desde el panel". El Concierge reescribe esta regla: *"puedes PROPONER acciones; nunca afirmes que algo quedó hecho hasta recibir el tool_result de la confirmación"*.

### 2.3 El loop de tools (compartido con Sofía)

`src/lib/ai/agent/loop.ts` → `runClinicalAgent(args)` ya es **parametrizable** (`tools`, `executeTool`, `systemPrompt`, `ctx`), despacha a Anthropic o OpenAI (`loop-openai.ts`), con `MAX_TOOL_ROUNDS = 6`. Contratos: `ToolDefinition` (JSON Schema estilo Anthropic), `ToolExecutor(name, input, ctx) → { content, isError }`, `AgentToolContext { db, accountId, userId, timezone, now, … }`. **El Concierge reutiliza este mismo loop** — solo necesita una variante con streaming y un callback de eventos (ver §7.3).

### 2.4 Datos y mutaciones que ya existen en el panel

Las mutaciones del panel hoy son *client-side* vía Supabase (RLS): `appointments.update({ status })` y `payments.insert/update` en `appointment-sheet.tsx`; `deals.update({ stage_id })` en `pipeline-board.tsx`/`deal-form.tsx`; `appointments.insert` en `new-appointment-dialog.tsx`. Tablas relevantes (migraciones 001, 031, 034, 041):

- `appointments` — `status ∈ {pendiente, confirmada, completada, cancelada, no_asistio}`, `deposit_status ∈ {no_aplica, pendiente, pagado}`, `starts_at/ends_at`, `procedure_id`.
- `payments` — `status ∈ {pendiente, confirmado, rechazado}`, `amount`, `method`, `receipt_url`.
- `deals` + `pipeline_stages` + `pipelines` (el "Embudo IA" vive en `/pipelines`).
- `contacts`, `patient_records` (expediente ligero, 041), `procedures` (catálogo), `clinic_hours`/`schedule_blocks` (disponibilidad), `notifications`, `payment_accounts`.

Esto define exactamente qué acciones puede proponer el Concierge sin inventar backend nuevo: son los mismos UPDATE/INSERT que el panel ya hace, movidos a un ejecutor server-side.

### 2.5 Next.js 16 — verificaciones hechas en `node_modules/next/dist/docs/`

- **Route handlers** (`01-app/03-api-reference/03-file-conventions/route.md`): siguen siendo `export async function POST(request: Request)` y **soportan streaming devolviendo `new Response(readableStream)`** (sección "Streaming", con el patrón `iteratorToStream`). Es la base del transporte del chat.
- Componentes de cliente: `'use client'` sin cambios para nuestro caso.
- Nota: en Next 16 `middleware` fue renombrado a `proxy` (`proxy.md`) y hay Cache Components — no afectan este diseño (todo el concierge es dinámico/autenticado), pero cualquier implementación debe releer el doc del área que toque.

---

## 3. Ubicación e integración: página dedicada `/concierge` (recomendada) + panel global después

**Recomendación: Fase 1 = página dedicada `/concierge`, primer ítem del sidebar** (icono Sparkles, arriba de "Conversaciones"), con el header del panel intacto. **Fase 3 = acceso global** con un botón en el header (y atajo `⌘K` / `Ctrl+K`) que abre un **panel lateral deslizable** (`Sheet` de `src/components/ui/sheet.tsx`, lado derecho, ~420px) reutilizando los mismos componentes del chat.

Por qué en ese orden y no al revés:

1. **El contenido lo exige.** Las respuestas del Concierge son tablas de agenda, tarjetas de paciente y action cards con detalle (fecha vieja → nueva, monto, comprobante). En un flotante de 380–420px eso se vuelve ilegible; en página completa (con transcript a `max-width ~48rem` centrado, como Claude/ChatGPT) respira. La pieza "central" del producto merece una URL propia, estado navegable (`/concierge?s=<session>`) y deep-links desde notificaciones.
2. **"Pieza central" = destino, no accesorio.** Si el pitch es "opera tu clínica hablando", la página es el home operativo del doctor. Un flotante comunica "widget de ayuda".
3. **El panel lateral sí aporta, pero como *segunda* superficie:** su valor real es la **inyección de contexto de ruta** ("estoy viendo el calendario del jueves" → el agente lo sabe). Eso requiere un contrato de contexto por página que conviene diseñar cuando el core ya funciona. Al compartir componentes (`<ConciergeThread>`, `<Composer>`), el costo marginal en Fase 3 es bajo.
4. **Riesgo de UX:** un floating button sobre el inbox/calendario compite con FABs y sheets existentes (appointment-sheet, lead-detail) y estorba en móvil. El ítem de sidebar + `⌘K` cubren el "acceso desde cualquier lado" sin ocupar viewport.

Integración concreta en Fase 1: agregar `{ href: "/concierge", label: "Concierge", icon: Sparkles }` al inicio de `navItems` en `src/components/layout/sidebar.tsx` y el título en `pageTitles` de `header.tsx`. La página vive en `src/app/(dashboard)/concierge/page.tsx` (hereda auth del `DashboardShell`).

---

## 4. Anatomía del chat

Estructura de la página (ver mockup):

```
┌─ Sidebar app ─┬─ Sesiones (260px, colapsable) ─┬─ Chat ──────────────────────┐
│ Concierge ●   │ [+ Nueva conversación]         │ Header: título · voz-toggle │
│ Conversaciones│ Hoy                            │ ┌─────────────────────────┐ │
│ CRM           │  ● Agenda y reagendado (activa)│ │ transcript max-w-3xl    │ │
│ Calendario    │  ○ Anticipo Karla Ortiz        │ │  burbujas + bloques     │ │
│ Notificaciones│ Ayer                           │ │  + action cards         │ │
│ …             │  ○ Embudo de la semana         │ └─────────────────────────┘ │
│               │                                │ Composer: 📎 [textarea] 🎤 ➤│
└───────────────┴────────────────────────────────┴─────────────────────────────┘
```

### 4.1 Historial de sesiones
- Rail izquierdo (260px) con "**+ Nueva conversación**", agrupación relativa (Hoy / Ayer / Últimos 7 días), título autogenerado tras el primer intercambio (una llamada barata al modelo o primeras ~6 palabras del primer mensaje). Hover → renombrar/eliminar. En `<lg` se colapsa a un dropdown en el header del chat.
- Fuente de verdad: `assistant_sessions` ordenadas por `last_message_at desc`. La sesión activa va en la URL (`?s=`) para deep-link y refresh sin pérdida.

### 4.2 Mensajes
- **Usuario:** burbuja alineada a la derecha, `bg-primary text-primary-foreground`, `rounded-2xl` con esquina inferior-derecha `rounded-br-sm` (mismo lenguaje que el chat interno actual y el inbox).
- **Asistente:** SIN burbuja contenedora pesada — texto sobre el fondo con avatar (Sparkles en chip `bg-primary-soft`), como Claude/Gemini. Deja respirar tablas y cards. Markdown ligero (negritas, listas, código inline) con un renderer propio pequeño — no traer una lib pesada.
- **Streaming de texto:** los deltas se agregan al último mensaje; caret parpadeante al final mientras `streaming=true`; indicador de actividad de tools ("Consultando agenda…", `animate-pulse-dot`) entre rondas del loop. Auto-scroll pegado al fondo *solo* si el usuario ya estaba al fondo (umbral ~80px); si scrolleó arriba, botón "↓ Nuevos mensajes".
- **Acciones por mensaje (asistente):** copiar · **reproducir voz (▶)** · regenerar (último). Aparecen en hover / siempre en touch.

### 4.3 Resultados estructurados (render blocks)
El texto del asistente puede intercalar **bloques estructurados** que el ejecutor de tools emite como eventos tipados (no parseando el texto del modelo):
- **`agenda_table`** — tabla de citas: hora (`.nums`), paciente, tipo, chip de estado (`confirmada`=success, `pendiente`=warning, `cancelada`=muted — reutilizar el sistema StatusBadge citado en globals.css), anticipo. Filas clicables → `/calendario`.
- **`patient_card`** — nombre, teléfono, etapa del embudo, últimas citas, expediente ligero; link a `/contacts/[id]`.
- **`funnel_summary`** — etapas del Embudo IA con conteo y valor (chips con color de `pipeline_stages.color`).
- **`deal_card`**, **`payment_row`** (con thumbnail del comprobante → lightbox).
Cada bloque lleva "Abrir en …" para saltar a la pantalla nativa: el Concierge *reduce* clicks, no encierra al usuario.

### 4.4 Action cards (detalle en §6)
Tarjeta `bg-card border rounded-xl shadow-soft` con icono del dominio (calendario/pago/embudo), título de la acción, tabla de detalles (antes → después), y footer según estado.

### 4.5 Adjuntos
- Botón 📎 + drag&drop sobre el composer + pegar imagen. Tipos: imagen (jpeg/png/webp) y PDF; máx ~8MB (mismo tope que `vision.ts`).
- Preview en el composer como chips con thumbnail y ✕; en el transcript, la imagen se muestra en la burbuja del usuario (click → lightbox), PDF como chip con icono.
- Subida a Supabase Storage reutilizando `src/lib/storage/upload-media.ts`; al modelo se le pasa como bloque de imagen (ambos providers soportan visión) o vía el pre-paso de `vision.ts` para comprobantes.

### 4.6 Audio del usuario (grabación)
- **Toggle, no push-to-talk:** click en 🎤 inicia; click en ⏹ (o `Esc`) detiene. Razón: el doctor dicta con una mano ocupada; mantener presionado falla en desktop (mouse) y compite con el scroll en móvil. Máx 2 min.
- Durante la grabación el composer se transforma: punto rojo pulsante + **waveform vivo** (canvas alimentado por `AnalyserNode` de Web Audio) + tiempo transcurrido + botones cancelar (✕) y enviar (✓).
- Al enviar: el audio sube a Storage, se transcribe server-side, y el mensaje del usuario aparece como **burbuja de audio** (waveform estático + duración + ▶) con la transcripción en texto pequeño debajo — el texto es lo que consume el modelo.
- Permiso de mic denegado → tooltip explicando cómo habilitarlo; el botón queda con badge de advertencia.

### 4.7 Voz de respuesta (TTS)
- **Toggle "Voz" en el header del chat** (persistido por usuario en localStorage): encendido = auto-play de cada respuesta del asistente al terminar (o por frases si se streamea el TTS en F2.5). Apagado = solo el botón ▶ por mensaje.
- Reproductor mínimo: el mensaje que suena muestra ecualizador animado + pausa; barra global no hace falta.
- Regla de cortesía: nunca auto-reproducir dos mensajes encimados; cola de uno; si el usuario empieza a escribir/grabar, se pausa.

### 4.8 Estados vacío / cargando / error
- **Vacío (sesión nueva):** saludo con el nombre del doctor + 4 chips de sugerencia accionables: "¿Cómo va el día?", "Anticipos por revisar", "¿Cómo va el embudo?", "Busca un paciente…". (El chip llena y envía.)
- **Cargando histórico:** skeletons de burbujas (2-3) con `animate-pulse`.
- **Error de turno:** el mensaje fallido queda en el transcript con borde `destructive/40` + "Reintentar"; el input del usuario NO se pierde (mismo patrón del chat interno actual: se restaura al composer).
- **`ai_not_configured`:** estado vacío especial con CTA "Configura tu agente" → `/agents?tab=setup`.
- **Acción expirada/conflicto:** la card pasa a estado `expired`/`failed` con explicación y botón "Volver a proponer".

---

## 5. Voz: arquitectura STT/TTS recomendada

### Comparativa

| | **OpenAI API** (key ya existente) | **Web Speech API** (navegador) |
|---|---|---|
| STT | `gpt-4o-mini-transcribe` ≈ $0.003/min · `gpt-4o-transcribe` ≈ $0.006/min. Español-MX excelente, robusto a jerga médica/dental ("endodoncia", "CLABE"), puntuación correcta. Latencia: ~1–2s para clips de 10–30s (aceptable: es dictado, no conversación en vivo). Funciona igual en todos los browsers (la captura es `MediaRecorder`, soporte universal). | `SpeechRecognition`: gratis, resultados parciales en vivo; pero es Chrome-céntrico (Safari/Firefox flojo o ausente), calidad es-MX irregular, sin control de vocabulario, y el audio se va a servidores de Google/Apple de todos modos (no es "más privado"). No deja guardar el audio original. |
| TTS | `gpt-4o-mini-tts` ≈ $0.015/min de audio; voces naturales con instrucciones de tono ("cálido, profesional, español mexicano"); streaming de audio soportado. | `speechSynthesis`: gratis e instantáneo, pero voces es-MX robóticas e inconsistentes por SO; imposible dar identidad de producto. |
| Costo real | Un doctor intensivo (~30 audios/día de 15s + ~5 min TTS/día) ≈ **$2–4 USD/mes**. Irrelevante frente al valor. | $0. |

### Recomendación

- **STT: OpenAI `gpt-4o-mini-transcribe`** vía `POST /api/ai/concierge/transcribe` (multipart: blob `audio/webm;codecs=opus` de `MediaRecorder`; en Safari cae a `audio/mp4` — mandar el mime real). El route handler llama a OpenAI con la key del servidor o la BYO de la cuenta y devuelve `{ text, durationMs }`. Subir a `gpt-4o-transcribe` solo si la mini falla con acentos/ruido de consultorio.
- **TTS: OpenAI `gpt-4o-mini-tts`** vía `GET/POST /api/ai/concierge/tts` (texto → `audio/mpeg` streameado al `<audio>`; el navegador reproduce progresivamente). Voz sugerida: `coral` o `nova` con instrucción de estilo fija. Cachear por hash(texto+voz) en Storage para replays gratis.
- **Key:** la cuenta ya guarda una key OpenAI cifrada (`ai_configs.embeddings_api_key`, siempre OpenAI — verificado en `config.ts`). Propuesta: **columna nueva `voice_api_key`** (o reutilizar la de embeddings con consentimiento explícito en Setup) para mantener el modelo BYO-key. Si no hay key OpenAI → los botones de voz caen al fallback.
- **Fallback (sin key / sin red / error):** Web Speech API — `speechSynthesis` para TTS y `SpeechRecognition` para STT solo-Chrome; si tampoco hay, los botones de voz se ocultan y el chat sigue 100% funcional por texto. La voz es *enhancement*, nunca dependencia.
- **Anthropic no ofrece STT/TTS** — la key de Anthropic sigue sirviendo para el cerebro del agente; la voz es ortogonal y siempre OpenAI/navegador.

---

## 6. Patrón de Action Cards (propose → confirm)

### 6.1 Máquina de estados

```
                    ┌────────────┐  usuario clic Confirmar   ┌───────────┐  ok   ┌──────────┐
 modelo llama tool  │  proposed  │ ─────────────────────────▶│ executing │──────▶│ executed │
 de escritura ────▶ │ (tarjeta   │                           │ (spinner) │       │ (check ✓)│
                    │  con botones)│ ─── usuario Cancelar ──▶ cancelled   │ error │
                    └────────────┘ ─── timeout 15 min ─────▶ expired      └──────▶ failed (Reintentar→nueva propuesta)
```

- **proposed:** card con resumen legible + detalles estructurados + botones `Confirmar` (variant default, primary) y `Cancelar` (variant ghost). Footer fijo: *"Esta acción no se ejecuta hasta que confirmes."*
- **executing:** botones → spinner + "Ejecutando…"; botones deshabilitados (doble-clic imposible: la transición de estado en BD es atómica).
- **executed:** banda `success/10`, icono ✓ `text-success`, timestamp y resumen del resultado ("Cita movida al jue 10 jul, 10:00"). Queda en el historial como registro de auditoría.
- **failed:** banda `destructive/10`, mensaje de error legible + "Volver a proponer".
- **cancelled / expired:** card atenuada (`opacity-60`), etiqueta gris. Las propuestas viejas de sesiones anteriores se muestran siempre como `expired` (no confirmables desde un historial reabierto días después: `expires_at` manda).

### 6.2 Contrato server-side (la parte no negociable)

1. El loop del agente corre con dos catálogos: `READ_TOOLS` (ejecutan directo, cliente RLS del usuario) y `WRITE_TOOLS`. Cuando el modelo llama una write-tool, el ejecutor **no muta nada**: valida el input contra el esquema y contra la BD (¿existe la cita? ¿el hueco sigue libre? ¿el monto coincide?), inserta `assistant_actions { status:'proposed', tool_name, input, summary, expires_at: now()+15min }`, emite el evento `action_proposal` al stream y devuelve al modelo un `tool_result`: *"Propuesta #id mostrada al usuario; NO está ejecutada; espera su decisión y no afirmes que quedó hecha."*
2. `POST /api/ai/concierge/actions/[id]/confirm` — con sesión del usuario (`requireRole('agent')`): `UPDATE assistant_actions SET status='executing', resolved_by=auth.uid() WHERE id=$1 AND account_id=$2 AND status='proposed' AND expires_at>now() RETURNING *` — si no devuelve fila, 409 (ya resuelta/expirada). Luego despacha a `executeConfirmedAction()` — **el único módulo del sistema que ejecuta estas mutaciones** — y persiste `executed|failed` + `result`. La UI actualiza la card y manda un turno de sistema al modelo ("acción #id ejecutada: …") para que narre el resultado.
3. `.../cancel` — misma transición atómica a `cancelled`.
4. Auditoría gratis: `assistant_actions` es el log de quién confirmó qué y cuándo (`resolved_by`, `resolved_at`).
5. Doble seguro contra prompt-injection/proactividad: las mutaciones corren con el **cliente RLS del usuario que confirmó**, jamás con service-role, y `executeConfirmedAction` re-valida el input contra la BD en el momento de ejecutar (el hueco pudo ocuparse entre propuesta y confirmación → `failed` con explicación, nunca doble-book).

### 6.3 Catálogo inicial de tools (12)

**Lectura (ejecutan directo — 6):** las 4 internas existentes (`consultar_agenda_dia`, `consultar_anticipos_pendientes`, `consultar_embudo`, `buscar_paciente`) + 2 adaptadas de Sofía a scope de cuenta: `consultar_disponibilidad` (huecos libres — necesaria antes de proponer citas) y `consultar_catalogo` (procedimientos/precios).

**Escritura (propose → confirm — 6):**

| Tool | Efecto al confirmar | Fuente en el repo |
|---|---|---|
| `agendar_cita` | INSERT en `appointments` (el doctor decide el status inicial; default `confirmada` — su confirmación ES la decisión humana) | `new-appointment-dialog.tsx` |
| `reagendar_cita` | UPDATE `starts_at/ends_at` (re-checa disponibilidad al ejecutar) | `agendar_cita` de Sofía + `appointment-sheet` |
| `actualizar_estado_cita` | UPDATE `status` (confirmada/completada/cancelada/no_asistio) | `appointment-sheet.tsx:78` |
| `validar_anticipo` | UPDATE `payments.status→confirmado` + `appointments.deposit_status→pagado`; la card muestra monto + thumbnail del comprobante para que el humano lo vea ANTES de confirmar | `appointment-sheet.tsx:121-149` |
| `mover_deal` | UPDATE `deals.stage_id` (etapas del Embudo IA) | `pipeline-board`/`deal-form.tsx` |
| `crear_nota_paciente` | INSERT en `patient_records` (categoría `nota`) | `registrar_dato_clinico` de Sofía |

Candidata para F3 (impacto externo, exige card con preview del texto): `enviar_whatsapp_paciente` (reutiliza `/api/whatsapp/send`).

---

## 7. Arquitectura frontend

### 7.1 Árbol de componentes

```
src/app/(dashboard)/concierge/page.tsx        (server component: metadata + shell)
src/components/concierge/
├── concierge-page.tsx        'use client' — orquestador: sesión activa (?s=), layout 2 columnas
├── session-list.tsx          rail de sesiones (grupos por fecha, renombrar/eliminar)
├── chat-thread.tsx           transcript virtual-scroll ligero + auto-scroll inteligente
│   ├── message-bubble.tsx    user (burbuja) / assistant (plano + avatar) + acciones hover
│   ├── markdown-lite.tsx     bold/listas/inline-code (sin dependencias)
│   ├── blocks/               render de resultados estructurados
│   │   ├── agenda-table.tsx · patient-card.tsx · funnel-summary.tsx · payment-row.tsx
│   ├── action-card.tsx       la tarjeta de confirmación (todos los estados §6.1)
│   ├── attachment-view.tsx   imagen/PDF en burbuja + lightbox
│   └── audio-message.tsx     waveform estático + play + transcripción
├── composer.tsx              textarea autosize + 📎 + 🎤 + ➤ + estado grabando
│   └── recorder-overlay.tsx  waveform vivo (canvas), timer, cancelar/enviar
├── voice-toggle.tsx          switch de auto-play TTS (header del chat)
├── suggestion-chips.tsx      estado vacío
└── hooks/
    ├── use-concierge-chat.ts   POST streaming + parser NDJSON + reducer del transcript
    ├── use-sessions.ts         CRUD sesiones (Supabase client + realtime opcional)
    ├── use-recorder.ts         MediaRecorder + AnalyserNode
    └── use-tts.ts              cola de reproducción, auto-play, cache por mensaje
```

### 7.2 Estado: qué vive dónde

- **Servidor (Supabase) = verdad:** sesiones, mensajes, acciones. El route handler del chat persiste el turno del usuario al recibirlo y el del asistente al terminar el stream (con sus `content_json` de bloques/acciones). Refresh a media respuesta = se pierde solo el delta visual, no datos.
- **Cliente (memoria del hook):** transcript de la sesión activa (hidratado con un fetch inicial), buffer de streaming, estado del composer/recorder, toggle de voz (localStorage). **No hace falta store global** (Zustand/Redux): todo el estado es local a la ruta; cuando llegue el panel global (F3), el hook se comparte tal cual.
- **Action cards:** el estado pintado sale de `assistant_actions`; tras confirmar/cancelar, la respuesta del endpoint actualiza la card en memoria (y un canal realtime sobre `assistant_actions` la sincroniza si hay dos pestañas).

### 7.3 Streaming: fetch streaming con eventos NDJSON (no EventSource)

Verificado en los docs de Next 16: un route handler devuelve `new Response(stream)` con un `ReadableStream` — patrón soportado de primera clase. Decisión:

- **`POST /api/ai/concierge/chat`** devuelve `Content-Type: application/x-ndjson` y el cliente lo lee con `res.body.getReader()` + `TextDecoder`, parseando una línea JSON por evento. **EventSource queda descartado** porque solo hace GET sin body (el turno del usuario + sessionId van en el POST) y su auto-reconexión no aplica a una completación one-shot. SSE formal no aporta nada extra aquí; NDJSON es más simple de parsear.
- **Protocolo de eventos** (permite empezar simple y crecer):
  ```
  {type:'session', sessionId}                      // si se creó sesión nueva
  {type:'status', label:'Consultando agenda…'}     // entre rondas de tools
  {type:'block', block:{kind:'agenda_table', …}}   // resultado estructurado
  {type:'action_proposal', action:{id, tool, summary, details, expiresAt}}
  {type:'text_delta', delta:'…'}                   // streaming del texto final
  {type:'done', messageId} | {type:'error', code, message}
  ```
- **Backend:** una variante `runConciergeAgent(args, { onEvent })` del loop actual: mismas rondas de tools (no-stream), pero la ronda final del modelo se pide con `stream: true` al provider (Anthropic Messages API y OpenAI soportan SSE) re-emitiendo deltas como `text_delta`. **Plan B de MVP si se quiere recortar:** solo eventos `status` + texto completo al final — la UI ya está preparada y el upgrade es interno al route handler.

### 7.4 Esquema Supabase (migración `043_concierge.sql`)

```sql
CREATE TABLE assistant_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE, -- dueño del hilo
  title text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_message_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE assistant_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES assistant_sessions(id) ON DELETE CASCADE,
  account_id uuid NOT NULL,                      -- desnormalizado para RLS barata
  role text NOT NULL CHECK (role IN ('user','assistant','system')),
  content text NOT NULL DEFAULT '',              -- texto plano (y transcripción si fue audio)
  content_json jsonb,                            -- bloques estructurados + tool_calls resumidos
  attachments jsonb,                             -- [{url, mime, name, bytes}]
  audio_url text,                                -- audio original del usuario / TTS cacheado
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON assistant_messages (session_id, created_at);

CREATE TABLE assistant_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- el "token de acción"
  account_id uuid NOT NULL,
  session_id uuid NOT NULL REFERENCES assistant_sessions(id) ON DELETE CASCADE,
  message_id uuid REFERENCES assistant_messages(id) ON DELETE SET NULL,
  origin text NOT NULL DEFAULT 'chat' CHECK (origin IN ('chat','proactive')),
  tool_name text NOT NULL,
  input jsonb NOT NULL,
  summary text NOT NULL,                         -- legible: "Reagendar a Laura Medina → jue 10:00"
  status text NOT NULL DEFAULT 'proposed'
    CHECK (status IN ('proposed','executing','executed','failed','cancelled','expired')),
  result jsonb, error text,
  proposed_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  resolved_by uuid REFERENCES auth.users(id),    -- QUIÉN confirmó (auditoría)
  resolved_at timestamptz
);
CREATE INDEX ON assistant_actions (account_id, status);

-- RLS en las tres: USING (is_account_member(account_id, 'agent'))
-- (sesiones visibles por cuenta; si se quiere privacidad por doctor, afinar a user_id = auth.uid()).
```

### 7.5 Endpoints

| Ruta | Método | Rol |
|---|---|---|
| `/api/ai/concierge/chat` | POST (streaming NDJSON) | turno de chat; crea sesión si no hay |
| `/api/ai/concierge/sessions` · `/sessions/[id]` | GET/POST · PATCH/DELETE | listar/crear · renombrar/borrar |
| `/api/ai/concierge/actions/[id]/confirm` · `/cancel` | POST | transición atómica + ejecución |
| `/api/ai/concierge/transcribe` | POST multipart | STT (F2) |
| `/api/ai/concierge/tts` | POST → audio/mpeg stream | TTS (F2) |

Todos con `requireRole('agent')` + rate limits como el endpoint actual.

---

## 8. Proactividad (Fase 3) — sin romper la regla de oro

- Un cron (patrón existente: `automations/cron`, `flows/cron`) genera **sugerencias**: "3 anticipos llevan >24h sin revisar", "mañana hay 2 citas sin confirmar", "5 leads en Interesado sin actividad en 7 días".
- Cada sugerencia se materializa como `assistant_actions` con `origin='proactive'` y `status='proposed'` (o simple tarjeta informativa sin acción). Se muestran en una franja "Sugerencias" arriba del chat + `notifications` existentes con deep-link a `/concierge`.
- **Nada proactivo ejecuta escrituras**: la proactividad solo *propone*; el confirm sigue siendo el mismo endpoint con el mismo gate humano. Automatizaciones 100% seguras (p.ej. "recuérdame…") pueden discutirse después con una allow-list explícita por cuenta.

---

## 9. Plan por fases

### Fase 1 — MVP texto + acciones (la que valida el producto)
**Crear (~19):** migración `043_concierge.sql` · `src/lib/ai/concierge/{tools,execute,actions,prompt,events}.ts` · rutas `chat/route.ts`, `sessions/route.ts`, `sessions/[id]/route.ts`, `actions/[id]/confirm/route.ts`, `actions/[id]/cancel/route.ts` · `app/(dashboard)/concierge/page.tsx` · componentes `concierge-page`, `session-list`, `chat-thread`, `message-bubble`, `markdown-lite`, `action-card`, `blocks/agenda-table` (+`patient-card`), `composer`, `suggestion-chips` · hooks `use-concierge-chat`, `use-sessions`.
**Tocar (~4):** `sidebar.tsx` (nav item) · `header.tsx` (título) · `src/lib/ai/agent/loop.ts` (o wrapper streaming en `concierge/`) · `src/lib/ai/internal/index.ts` (re-exports).
Alcance funcional: sesiones persistidas, streaming (o plan B de status+texto), 6 read-tools, 6 write-tools con action cards y confirmación de dos fases.

### Fase 2 — Voz y adjuntos ✅ (construida)
**Crear (~7):** `transcribe/route.ts`, `tts/route.ts` · `recorder-overlay.tsx`, `audio-message.tsx`, `attachment-view.tsx`, `voice-toggle.tsx` · hooks `use-recorder`, `use-tts`.
**Tocar (~4):** `composer.tsx` (mic + adjuntos) · `chat-thread`/`message-bubble` (audio/attachments) · `chat/route.ts` (attachments al modelo vía visión) · Setup de `/agents` (campo voice key / consentimiento embeddings-key) + columna `voice_api_key` (mini-migración).

**Cómo quedó realmente (desviaciones del plan):**
- **Sin migración nueva**: adjuntos, `via_voz` y bloques viven en `assistant_messages.content_json`; el audio del dictado NO se persiste (solo la transcripción, marcada "dictado por voz") — se transcribe directo del blob sin pasar por Storage.
- **Key de voz sin columna nueva**: `pickVoiceApiKey()` usa la key del agente si el proveedor es OpenAI, o la de embeddings si es Anthropic; sin key OpenAI → `voice_unavailable` (dictado deshabilitado, TTS cae a `speechSynthesis`).
- **Dictado con revisión**: con "Voz" apagada la transcripción cae al composer para editar; con "Voz" encendida el mic entra en **modo conversación** (envía solo, lee la respuesta con TTS y re-escucha con VAD de silencio ~2s; Esc/✕ rompen el ciclo). El tope duro de grabación es 2 min.
- **Adjuntos**: imágenes (jpeg/png/webp ≤5MB) + PDF (≤16MB), máx 3 por turno, al bucket `chat-media`; el server solo acepta URLs de ese bucket (anti-SSRF) y analiza hasta 2 imágenes por turno con `analyzeReceiptImage` (mismo pre-paso de visión de Sofía). Los PDF solo se anuncian por nombre.
- **Extras que se adelantaron de §4.3**: bloque `agenda` (widget de citas del día que emite `consultar_agenda_dia`, con estados crudos para chips y link a /calendario) y tool `abrir_seccion` (navegación autónoma con allow-list: calendario/conversaciones/crm/embudo/notificaciones; emite bloque `navegacion` — en vivo el cliente hace `router.push`, hidratado solo pinta el chip).
- El protocolo NDJSON ganó el evento `{type:'block', block}`.

### Fase 3 — Proactividad + acceso global
**Crear (~6):** `concierge/cron/route.ts` + `src/lib/ai/concierge/proactive.ts` (reglas) · `suggestions-strip.tsx` · `concierge-sheet.tsx` (Sheet global) + trigger en header con `⌘K` · contrato de contexto por ruta (`use-route-context.ts`) · tool `enviar_whatsapp_paciente`.
**Tocar (~4):** `dashboard-shell.tsx` (montar sheet global) · `header.tsx` (botón) · `notifications` (tipo nuevo con deep-link) · `tools.ts` del concierge.

---

## 10. Riesgos y decisiones abiertas

1. **Privacidad de sesiones:** ¿hilos visibles por toda la cuenta o por usuario? Propuesta: por cuenta (RLS `agent+`) para que el equipo comparta contexto; revisar cuando haya multiusuario real.
2. **Status de cita creada por el doctor:** propuse default `confirmada` (su confirm ES la decisión humana). Validar con Emiliano — si prefiere conservadurismo, default `pendiente` con checkbox en la card.
3. **TTS streaming por frases** (latencia percibida) es un refinamiento post-F2; el MVP de voz reproduce al terminar el mensaje.
4. **Tope de contexto:** heredar `MAX_TURNS=20` del endpoint actual y truncar server-side desde `assistant_messages` (el cliente ya no reenvía el transcript: manda solo `sessionId + userTurn`).
