-- ============================================================
-- 031_clinic_scheduling.sql — clinicOS: citas, catálogo y anticipos
--
-- Primer bloque de dominio clínico sobre la base wacrm. Modelo guiado
-- por los contratos del legacy (docs/legacy-clinicos/contratos/agenda.ts):
--
--   - `procedures`       catálogo de la clínica: precios (rango), anticipo
--                        requerido, duración y notas de venta (directrices
--                        que consume el agente de atención).
--   - `clinic_hours`     horario semanal de atención (varios bloques por
--                        día permitidos, ej. mañana y tarde).
--   - `schedule_blocks`  bloqueos puntuales (cirugías, vacaciones).
--   - `appointments`     citas ligadas a contacto y opcionalmente a la
--                        conversación de WhatsApp que las originó.
--   - `payments`         pagos/anticipos. Regla de oro del legacy: la IA
--                        solo PREVALIDA (status 'pendiente'); un humano
--                        confirma en el panel, y solo entonces la cita
--                        pasa a 'confirmada'.
--
-- Estados de cita:  pendiente → confirmada → completada
--                              ↘ cancelada / no_asistio
--   'pendiente' cubre "esperando anticipo" cuando deposit_status =
--   'pendiente'; una cita sin anticipo requerido nace 'confirmada'.
--
-- RLS: espeja el resto del dominio operativo — lectura para cualquier
-- miembro (viewer+), escritura para agent+; el catálogo y los horarios
-- son settings-class (escritura admin+). El agente IA y el webhook
-- escriben con el cliente service-role, igual que el resto de motores.
--
-- Idempotente — seguro de correr varias veces.
-- ============================================================

-- ------------------------------------------------------------
-- Catálogo de procedimientos
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS procedures (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name              text NOT NULL,
  description       text,
  category          text,                              -- ej. 'valoracion', 'estetica', 'dental'
  price_min         numeric(12,2),
  price_max         numeric(12,2),
  currency          text NOT NULL DEFAULT 'MXN',
  deposit_amount    numeric(12,2),                     -- NULL = no requiere anticipo
  duration_minutes  integer NOT NULL DEFAULT 60 CHECK (duration_minutes BETWEEN 5 AND 720),
  sales_notes       text,                              -- directrices de venta para el agente
  is_active         boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_procedures_account ON procedures(account_id) WHERE is_active;

-- ------------------------------------------------------------
-- Horario semanal (0 = domingo … 6 = sábado, hora local de la clínica)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS clinic_hours (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  weekday       integer NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  opens_at      time NOT NULL,
  closes_at     time NOT NULL,
  slot_minutes  integer NOT NULL DEFAULT 30 CHECK (slot_minutes BETWEEN 5 AND 240),
  CHECK (opens_at < closes_at)
);

CREATE INDEX IF NOT EXISTS idx_clinic_hours_account ON clinic_hours(account_id, weekday);

-- ------------------------------------------------------------
-- Bloqueos de agenda (cirugías, vacaciones, comidas puntuales)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS schedule_blocks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  starts_at   timestamptz NOT NULL,
  ends_at     timestamptz NOT NULL,
  reason      text,
  created_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (starts_at < ends_at)
);

CREATE INDEX IF NOT EXISTS idx_schedule_blocks_account_time
  ON schedule_blocks(account_id, starts_at);

-- ------------------------------------------------------------
-- Citas
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS appointments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id       uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  conversation_id  uuid REFERENCES conversations(id) ON DELETE SET NULL,
  procedure_id     uuid REFERENCES procedures(id) ON DELETE SET NULL,
  appointment_type text NOT NULL DEFAULT 'valoracion'
                     CHECK (appointment_type IN
                       ('valoracion', 'valoracion_virtual', 'seguimiento', 'procedimiento', 'otro')),
  status           text NOT NULL DEFAULT 'pendiente'
                     CHECK (status IN
                       ('pendiente', 'confirmada', 'completada', 'cancelada', 'no_asistio')),
  deposit_status   text NOT NULL DEFAULT 'no_aplica'
                     CHECK (deposit_status IN ('no_aplica', 'pendiente', 'pagado')),
  deposit_amount   numeric(12,2),                      -- snapshot del anticipo requerido al agendar
  starts_at        timestamptz NOT NULL,
  ends_at          timestamptz NOT NULL,
  notes            text,
  created_by       uuid REFERENCES auth.users(id) ON DELETE SET NULL,  -- NULL = creada por el agente IA
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (starts_at < ends_at)
);

CREATE INDEX IF NOT EXISTS idx_appointments_account_time ON appointments(account_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_appointments_contact ON appointments(contact_id);

-- ------------------------------------------------------------
-- Pagos / anticipos
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id      uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  appointment_id  uuid REFERENCES appointments(id) ON DELETE SET NULL,
  amount          numeric(12,2) NOT NULL CHECK (amount > 0),
  currency        text NOT NULL DEFAULT 'MXN',
  method          text NOT NULL DEFAULT 'transferencia'
                    CHECK (method IN ('transferencia', 'efectivo', 'tarjeta', 'link', 'otro')),
  status          text NOT NULL DEFAULT 'pendiente'
                    CHECK (status IN ('pendiente', 'confirmado', 'rechazado')),
  concept         text,                                -- ej. 'Anticipo valoración'
  receipt_url     text,                                -- comprobante que mandó el paciente
  confirmed_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  confirmed_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payments_account ON payments(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payments_appointment ON payments(appointment_id);

-- ------------------------------------------------------------
-- RLS
-- ------------------------------------------------------------
ALTER TABLE procedures      ENABLE ROW LEVEL SECURITY;
ALTER TABLE clinic_hours    ENABLE ROW LEVEL SECURITY;
ALTER TABLE schedule_blocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE appointments    ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments        ENABLE ROW LEVEL SECURITY;

-- Catálogo y horarios: lectura miembros, escritura admin+ (settings-class).
DROP POLICY IF EXISTS procedures_select ON procedures;
CREATE POLICY procedures_select ON procedures FOR SELECT
  USING (is_account_member(account_id));
DROP POLICY IF EXISTS procedures_write ON procedures;
CREATE POLICY procedures_write ON procedures FOR ALL
  USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS clinic_hours_select ON clinic_hours;
CREATE POLICY clinic_hours_select ON clinic_hours FOR SELECT
  USING (is_account_member(account_id));
DROP POLICY IF EXISTS clinic_hours_write ON clinic_hours;
CREATE POLICY clinic_hours_write ON clinic_hours FOR ALL
  USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));

-- Operativo (citas, bloqueos, pagos): lectura miembros, escritura agent+.
DROP POLICY IF EXISTS schedule_blocks_select ON schedule_blocks;
CREATE POLICY schedule_blocks_select ON schedule_blocks FOR SELECT
  USING (is_account_member(account_id));
DROP POLICY IF EXISTS schedule_blocks_write ON schedule_blocks;
CREATE POLICY schedule_blocks_write ON schedule_blocks FOR ALL
  USING (is_account_member(account_id, 'agent'))
  WITH CHECK (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS appointments_select ON appointments;
CREATE POLICY appointments_select ON appointments FOR SELECT
  USING (is_account_member(account_id));
DROP POLICY IF EXISTS appointments_write ON appointments;
CREATE POLICY appointments_write ON appointments FOR ALL
  USING (is_account_member(account_id, 'agent'))
  WITH CHECK (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS payments_select ON payments;
CREATE POLICY payments_select ON payments FOR SELECT
  USING (is_account_member(account_id));
DROP POLICY IF EXISTS payments_write ON payments;
CREATE POLICY payments_write ON payments FOR ALL
  USING (is_account_member(account_id, 'agent'))
  WITH CHECK (is_account_member(account_id, 'agent'));

-- ------------------------------------------------------------
-- updated_at
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.update_clinic_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS procedures_updated_at ON procedures;
CREATE TRIGGER procedures_updated_at
  BEFORE UPDATE ON procedures
  FOR EACH ROW EXECUTE FUNCTION public.update_clinic_updated_at();

DROP TRIGGER IF EXISTS appointments_updated_at ON appointments;
CREATE TRIGGER appointments_updated_at
  BEFORE UPDATE ON appointments
  FOR EACH ROW EXECUTE FUNCTION public.update_clinic_updated_at();

DROP TRIGGER IF EXISTS payments_updated_at ON payments;
CREATE TRIGGER payments_updated_at
  BEFORE UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION public.update_clinic_updated_at();

-- ------------------------------------------------------------
-- Realtime: el calendario y el CRM se refrescan en vivo cuando el
-- agente (service-role) agenda o un pago cambia de estado.
-- ------------------------------------------------------------
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE appointments;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE payments;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
