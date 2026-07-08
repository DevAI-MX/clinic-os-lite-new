-- ------------------------------------------------------------
-- 048 — Confirmación de pagos desde el panel (botón "Confirmar pago").
--
-- Amplía los tipos de `notifications` en dos frentes:
--
--   * `deposit_confirmed` — lo deja el flujo del botón "Confirmar
--     pago" (CRM / inbox / hoja de cita) cuando el equipo valida el
--     comprobante: el pago pasa a 'confirmado', la cita a 'confirmada'
--     y se le avisa al paciente por WhatsApp. La notificación deja
--     rastro auditable de quién confirmó y de que el aviso salió.
--
--   * `ai_appointment_cancelled` — BUGFIX: cancelarCita (execute.ts)
--     inserta este tipo desde el agente, pero nunca estuvo en el CHECK
--     de la migración 032, así que el INSERT violaba la restricción y
--     fallaba EN SILENCIO (dropNotification no revisa el error): las
--     cancelaciones de pacientes nunca dejaban aviso al equipo.
--
-- Mismo patrón idempotente que la 032: se reemplaza el constraint.
-- La UI de Notificaciones renderiza title/body genéricos y cae a un
-- icono por defecto para tipos nuevos, así que ampliar es seguro.
-- ------------------------------------------------------------

ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications
  ADD CONSTRAINT notifications_type_check
  CHECK (type IN (
    'conversation_assigned',
    'ai_escalation',            -- el agente pasó la conversación a un humano
    'ai_deposit_prevalidated',  -- el agente prevalidó un anticipo (falta confirmar)
    'ai_appointment_created',   -- el agente apartó/agendó una cita (falta confirmar)
    'ai_appointment_cancelled', -- el agente canceló una cita a petición del paciente
    'deposit_confirmed'         -- el equipo confirmó el pago (cita confirmada + aviso al paciente)
  ));
