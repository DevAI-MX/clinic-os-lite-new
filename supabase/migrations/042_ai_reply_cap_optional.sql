-- ============================================================
-- 042 — Tope de auto-respuestas: opcional, y sin tope por default.
--
-- Incidente Acerotech (2026-07-07): con auto_reply_max_per_conversation
-- en 8, el agente enmudeció EXACTAMENTE cuando el lead aceptó la cita
-- ("Mañana 4:30" → silencio). Una conversación de venta real (calificar
-- → cotizar → agendar → anticipo → comprobante) consume 8 respuestas
-- sin despeinarse. Decisión de producto (Emiliano, 2026-07-07): el
-- agente NO debe toparse — el tope pasa a ser opcional:
--
--   * 0 = SIN TOPE (nuevo default; todas las cuentas existentes se
--     migran a 0 — el "callarse" era un bug operativo, no una
--     preferencia);
--   * un valor > 0 sigue funcionando como freno de gasto, pero (en
--     app, auto-reply.ts) alcanzarlo ya no silencia al paciente:
--     apaga el auto-reply y notifica al equipo.
--
-- Idempotente: DROP ... IF EXISTS + ADD tras verificar.
-- ============================================================

ALTER TABLE ai_configs
  DROP CONSTRAINT IF EXISTS ai_configs_auto_reply_max_per_conversation_check;

ALTER TABLE ai_configs
  ADD CONSTRAINT ai_configs_auto_reply_max_per_conversation_check
  CHECK (auto_reply_max_per_conversation BETWEEN 0 AND 10000);

ALTER TABLE ai_configs
  ALTER COLUMN auto_reply_max_per_conversation SET DEFAULT 0;

UPDATE ai_configs SET auto_reply_max_per_conversation = 0;
