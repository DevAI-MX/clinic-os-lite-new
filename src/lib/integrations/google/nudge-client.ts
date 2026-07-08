/**
 * Cliente: dispara (fire-and-forget) el drenado de la cola de
 * sincronización de Google Calendar para la cuenta de la sesión, para que
 * una cita creada/editada/cancelada en el panel aparezca en el calendario
 * "Clínica" de Google casi al instante.
 *
 * No se espera (`void`): la UI nunca debe bloquearse por Google. Si la
 * llamada falla, se ignora a propósito — el barrido de respaldo (enganchado
 * a /api/automations/cron) drena la cola en el siguiente ciclo, así que la
 * cita se sincroniza igual, solo con algo más de latencia. `keepalive`
 * permite que la petición sobreviva aunque el diálogo se cierre justo
 * después de guardar.
 */
export function nudgeCalendarSync(): void {
  void fetch('/api/integrations/google/calendar/sync/nudge', {
    method: 'POST',
    cache: 'no-store',
    keepalive: true,
  }).catch(() => {})
}
