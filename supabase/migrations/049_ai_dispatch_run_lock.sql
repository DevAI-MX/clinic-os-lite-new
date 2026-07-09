-- ============================================================
-- 049_ai_dispatch_run_lock.sql — mutex spanning the FULL agent run,
-- not just the debounce wait.
--
-- Problem (incidente Acerotech, 2026-07-08): el debounce (035) solo
-- agrupa mensajes dentro de una ráfaga de ~9s de silencio; no protege
-- la CORRIDA del agente en sí (llamadas al LLM + tools + posible
-- ronda de reparación del guardrail), que puede tardar bastante más
-- que eso. Dos mensajes del paciente separados por más de la ventana
-- de debounce, pero mientras la corrida anterior sigue viva, ganan
-- cada uno su propio claim de ráfaga y corren el agente clínico EN
-- PARALELO — cada corrida agenda por su cuenta y ambas terminan
-- mandando el bloque de datos bancarios (contradictorio: dos días
-- distintos, mismo anticipo, 0.5s de diferencia entre los dos envíos).
--
-- Fix: un candado adicional, separado del due_at de la ráfaga, que
-- cubre toda la corrida (desde que gana el claim de la ráfaga hasta
-- que termina de enviar o falla). Con expiración
-- (`stale_after_seconds`) por si una invocación muere sin liberar el
-- candado (timeout/OOM del runtime serverless) — evita que una
-- corrida caída deje la conversación muda para siempre.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS ai_dispatch_running_at timestamptz;

-- ============================================================
-- Atomic run-lock acquire. Succeeds only if no run is currently
-- marked in progress, or the mark is older than `stale_after_seconds`
-- (a crashed invocation that never released it).
-- ============================================================
CREATE OR REPLACE FUNCTION public.acquire_ai_dispatch_run_lock(
  conversation_id uuid,
  stale_after_seconds integer DEFAULT 180
)
RETURNS boolean AS $$
  WITH locked AS (
    UPDATE conversations
    SET ai_dispatch_running_at = now()
    WHERE id = conversation_id
      AND (
        ai_dispatch_running_at IS NULL
        OR ai_dispatch_running_at < now() - make_interval(secs => stale_after_seconds)
      )
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM locked);
$$ LANGUAGE sql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.release_ai_dispatch_run_lock(
  conversation_id uuid
)
RETURNS void AS $$
  UPDATE conversations
  SET ai_dispatch_running_at = NULL
  WHERE id = conversation_id;
$$ LANGUAGE sql SECURITY DEFINER SET search_path = public;
