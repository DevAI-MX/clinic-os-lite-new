-- ============================================================
-- 041_patient_records.sql — clinicOS: expediente clínico ligero
--
-- Fase 2 del RAG. El agente de Atención solo recuerda los últimos 40
-- mensajes de la conversación: lo que un paciente contó hace semanas
-- (síntomas, alergias, medicamentos, tratamientos previos) se pierde.
-- Este expediente guarda esos HECHOS como entradas atómicas por
-- paciente, y el agente los consulta/registra con herramientas
-- (`consultar_expediente` / `registrar_dato_clinico`).
--
-- Aislamiento (lección del incidente Acerotech): cada entrada cuelga de
-- (account_id, contact_id) y las herramientas SIEMPRE filtran por el
-- contacto de la conversación — mismo patrón que `consultar_mis_citas`.
-- Es imposible que el expediente de un paciente aparezca en el chat de
-- otro: la herramienta ni siquiera acepta un contact_id como parámetro.
--
-- Reglas de contenido (viven en las descripciones de las tools):
--   * Solo hechos QUE DIJO EL PACIENTE, nunca diagnósticos de la IA.
--   * Entradas cortas y atómicas (una por hecho, máx 500 caracteres).
--
-- Borrado: ON DELETE CASCADE con el contacto — el botón rojo del panel
-- (migración 037) arrasa también el expediente, coherente con la
-- decisión de producto de que borrar un contacto no deje rastro.
--
-- RLS: clase operativa, igual que `appointments`/`payments` — lectura
-- para cualquier miembro, escritura agent+. El agente escribe con el
-- cliente service-role filtrando por account/contact en código.
--
-- Idempotente — seguro de correr varias veces.
-- ============================================================

CREATE TABLE IF NOT EXISTS patient_records (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id      uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  category        text NOT NULL CHECK (category IN (
                    'motivo_consulta',    -- qué lo trae a la clínica
                    'sintoma',            -- molestias que describe
                    'alergia',            -- alergias declaradas
                    'medicamento',        -- qué toma actualmente
                    'antecedente',        -- padecimientos/cirugías previas
                    'tratamiento_previo', -- tratamientos que ya intentó
                    'nota'                -- otro dato clínico relevante
                  )),
  content         text NOT NULL CHECK (length(content) BETWEEN 1 AND 500),
  source          text NOT NULL DEFAULT 'agente' CHECK (source IN ('agente', 'equipo')),
  is_active       boolean NOT NULL DEFAULT true,
  created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,  -- NULL = registrada por el agente IA
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- El acceso es siempre "el expediente de ESTE paciente", nunca global.
CREATE INDEX IF NOT EXISTS idx_patient_records_contact
  ON patient_records(account_id, contact_id) WHERE is_active;

ALTER TABLE patient_records ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS patient_records_select ON patient_records;
CREATE POLICY patient_records_select ON patient_records FOR SELECT
  USING (is_account_member(account_id));
DROP POLICY IF EXISTS patient_records_write ON patient_records;
CREATE POLICY patient_records_write ON patient_records FOR ALL
  USING (is_account_member(account_id, 'agent'))
  WITH CHECK (is_account_member(account_id, 'agent'));

DROP TRIGGER IF EXISTS patient_records_updated_at ON patient_records;
CREATE TRIGGER patient_records_updated_at
  BEFORE UPDATE ON patient_records
  FOR EACH ROW EXECUTE FUNCTION public.update_clinic_updated_at();
