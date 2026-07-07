-- ============================================================
-- 043_concierge.sql — clinicOS: Agente Concierge (Fase 1)
--
-- El "asistente interno" (solo lectura, stateless) evoluciona a
-- Concierge: chat con sesiones persistentes donde el equipo también
-- EJECUTA acciones (reagendar, validar anticipo, mover deal, etc.)
-- con un patrón estricto propose → confirm. El servidor nunca muta
-- nada sin el clic de "Confirmar" del humano en la UI — así se
-- conserva la regla de oro del producto (pagos y citas los decide un
-- humano): la confirmación del humano en el chat ES el acto humano.
--
-- Tablas:
--   * assistant_sessions  — un hilo de conversación por equipo/cuenta.
--   * assistant_messages  — turnos del hilo (texto + bloques + adjuntos).
--   * assistant_actions   — propuestas de mutación con máquina de
--     estados proposed → executing → executed|failed, o
--     proposed → cancelled|expired. Es también el log de auditoría
--     (resolved_by/resolved_at registran quién confirmó qué y cuándo).
--
-- RLS: clase operativa (igual que appointments/payments) — lectura
-- para cualquier miembro, escritura agent+. Las sesiones son visibles
-- por CUENTA (no solo por su dueño) para que el equipo comparta
-- contexto; revisar si el multiusuario real pide privacidad por
-- doctor más adelante.
--
-- Idempotente — seguro de correr varias veces.
-- ============================================================

CREATE TABLE IF NOT EXISTS assistant_sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_message_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_assistant_sessions_account
  ON assistant_sessions(account_id, last_message_at DESC);

ALTER TABLE assistant_sessions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS assistant_sessions_select ON assistant_sessions;
CREATE POLICY assistant_sessions_select ON assistant_sessions FOR SELECT
  USING (is_account_member(account_id));
DROP POLICY IF EXISTS assistant_sessions_write ON assistant_sessions;
CREATE POLICY assistant_sessions_write ON assistant_sessions FOR ALL
  USING (is_account_member(account_id, 'agent'))
  WITH CHECK (is_account_member(account_id, 'agent'));

CREATE TABLE IF NOT EXISTS assistant_messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      uuid NOT NULL REFERENCES assistant_sessions(id) ON DELETE CASCADE,
  account_id      uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  role            text NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content         text NOT NULL DEFAULT '',
  -- Bloques estructurados (agenda_table, patient_card, funnel_summary,
  -- action_proposal…) que la UI renderiza sin parsear el texto del modelo.
  content_json    jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_assistant_messages_session
  ON assistant_messages(session_id, created_at);

ALTER TABLE assistant_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS assistant_messages_select ON assistant_messages;
CREATE POLICY assistant_messages_select ON assistant_messages FOR SELECT
  USING (is_account_member(account_id));
DROP POLICY IF EXISTS assistant_messages_write ON assistant_messages;
CREATE POLICY assistant_messages_write ON assistant_messages FOR ALL
  USING (is_account_member(account_id, 'agent'))
  WITH CHECK (is_account_member(account_id, 'agent'));

CREATE TABLE IF NOT EXISTS assistant_actions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- el "token de acción"
  account_id      uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  session_id      uuid NOT NULL REFERENCES assistant_sessions(id) ON DELETE CASCADE,
  message_id      uuid REFERENCES assistant_messages(id) ON DELETE SET NULL,
  tool_name       text NOT NULL,
  input           jsonb NOT NULL,
  summary         text NOT NULL, -- legible: "Reagendar a Laura Medina → jue 10:00"
  status          text NOT NULL DEFAULT 'proposed'
                    CHECK (status IN ('proposed', 'executing', 'executed', 'failed', 'cancelled', 'expired')),
  result          jsonb,
  error           text,
  proposed_at     timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  resolved_by     uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  resolved_at     timestamptz
);

CREATE INDEX IF NOT EXISTS idx_assistant_actions_account_status
  ON assistant_actions(account_id, status);

ALTER TABLE assistant_actions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS assistant_actions_select ON assistant_actions;
CREATE POLICY assistant_actions_select ON assistant_actions FOR SELECT
  USING (is_account_member(account_id));
DROP POLICY IF EXISTS assistant_actions_write ON assistant_actions;
CREATE POLICY assistant_actions_write ON assistant_actions FOR ALL
  USING (is_account_member(account_id, 'agent'))
  WITH CHECK (is_account_member(account_id, 'agent'));

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE assistant_actions;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
