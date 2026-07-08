// ============================================================
// clinicOS — cliente del botón "Confirmar pago".
//
// Wrapper compartido por las cuatro superficies del panel (pestaña
// Citas del CRM, tarjeta del inbox, menú del hilo y hoja de cita del
// calendario) sobre POST /api/appointments/[id]/confirm-deposit, más
// el texto del toast según cómo terminó el aviso por WhatsApp.
// ============================================================

export interface ConfirmDepositResponse {
  ok: boolean
  alreadyConfirmed?: boolean
  appointmentStatus?: string
  whatsapp?: 'sent' | 'skipped' | 'no_conversation' | 'failed'
}

/** Lanza Error con el mensaje del servidor si la confirmación falla. */
export async function confirmDepositRequest(
  appointmentId: string,
): Promise<ConfirmDepositResponse> {
  const res = await fetch(`/api/appointments/${appointmentId}/confirm-deposit`, {
    method: 'POST',
  })
  const data = (await res.json().catch(() => null)) as
    | (ConfirmDepositResponse & { error?: string })
    | null
  if (!res.ok || !data?.ok) {
    throw new Error(data?.error || 'No se pudo confirmar el pago')
  }
  return data
}

/** Toast de éxito honesto: dice si el WhatsApp al paciente salió o no. */
export function confirmDepositToast(
  whatsapp: ConfirmDepositResponse['whatsapp'],
): string {
  switch (whatsapp) {
    case 'sent':
      return 'Pago confirmado — cita confirmada y paciente avisado por WhatsApp'
    case 'no_conversation':
      return 'Pago confirmado — cita confirmada (sin conversación de WhatsApp donde avisarle)'
    case 'failed':
      return 'Pago confirmado — cita confirmada, pero el WhatsApp al paciente falló: avísale tú desde el inbox'
    default:
      return 'Pago confirmado — cita confirmada'
  }
}
