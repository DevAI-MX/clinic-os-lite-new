# Cómo correr clinicOS en local

La app (panel Next.js) corre en tu Mac en **http://localhost:3000**.
La base de datos (Postgres + Auth + Storage) vive en **Supabase**.

> Intentamos Supabase 100% local con Docker/Colima, pero este entorno no
> puede descargar la imagen de la VM (la red no soporta descargas por
> rango). La ruta recomendada — y la misma que usarás en producción sobre
> el VPS — es un **proyecto Supabase en la nube** (plan gratis alcanza de
> sobra para desarrollo). No necesita Docker.

## Paso 1 — Crear el proyecto Supabase (una sola vez, ~3 min)

1. Entra a <https://supabase.com> → **New project**.
2. Región: la más cercana (ej. *South America (São Paulo)* o *East US*).
3. Pon una **contraseña de base de datos** y guárdala.
4. Cuando termine de aprovisionar, ve a **Settings → API** y copia:
   - **Project URL** → `https://xxxx.supabase.co`
   - **anon public** key
   - **service_role** key
   Y en **Settings → General**, el **Reference ID** (el `xxxx`).

## Paso 2 — Aplicar el esquema y sembrar datos

```bash
# Aplica las 31 migraciones (CRM, WhatsApp, IA + dominio clínico) al
# Postgres de la nube. Sin Docker.
bash scripts/bootstrap-cloud.sh <REFERENCE_ID> <DB_PASSWORD>
```

Luego pega las tres llaves en `.env.local`:

```
NEXT_PUBLIC_SUPABASE_URL=https://xxxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon public>
SUPABASE_SERVICE_ROLE_KEY=<service_role>
```

Y siembra el demo (usuario, catálogo, contactos con conversaciones, citas):

```bash
npm run seed:demo
```

## Paso 3 — Arrancar el panel

```bash
npm run dev
```

Abre <http://localhost:3000>, entra con:

- **covarrubiasmataemiliano@gmail.com** / **clinicos123**

Verás las 5 secciones de la V1: **Conversaciones**, **CRM**,
**Calendario**, **Notificaciones** y **Configuración**.

---

## Conectar WhatsApp real (Zernio) — cuando tengas las credenciales

El sistema ya trae el adaptador de Zernio. Hoy corre en **dry-run**
(`ZERNIO_DRY_RUN=true` en `.env.local`): puedes probar todo el panel sin
enviar mensajes reales. Para conectar tu número:

1. En el dashboard de Zernio saca tu **API key** y el **account id** del
   número de WhatsApp conectado.
2. En `.env.local`:
   ```
   ZERNIO_API_KEY=<tu api key>
   ZERNIO_ACCOUNT_ID=<id de la cuenta de WhatsApp en Zernio>
   ZERNIO_WEBHOOK_SECRET=<un secreto que tú eliges>
   # ZERNIO_DRY_RUN=true   ← comenta o borra esta línea al conectar de verdad
   ```
3. Registra el webhook de Zernio apuntando a tu despliegue (ver
   `docs/ZERNIO.md` para el `curl` exacto y la lista de eventos).

Detalle completo, límites conocidos y el mapeo de mensajes:
**`docs/ZERNIO.md`**.

---

## Documentos relacionados

- `docs/RECONSTRUCCION.md` — arquitectura, decisión de agentes, roadmap.
- `docs/ZERNIO.md` — integración de WhatsApp vía Zernio.
- `docs/legacy-clinicos/` — material rescatado del sistema anterior
  (prompts de venta, contexto de negocio, diseño de UI).
- `supabase/migrations/031_clinic_scheduling.sql` — el dominio clínico
  nuevo (citas, catálogo, anticipos).
