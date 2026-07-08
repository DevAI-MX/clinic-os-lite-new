import { NextResponse } from 'next/server'

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { getZernioConnectionStatus } from '@/lib/zernio/client'

/**
 * GET /api/zernio/status  (cualquier miembro autenticado)
 *
 * Valida EN VIVO que el WhatsApp de la clínica está conectado por Zernio
 * y que la API key es válida — hace un GET real a Zernio (/v1/accounts),
 * no solo mira las variables de entorno. Alimenta la tarjeta de WhatsApp
 * en Ajustes. No expone la API key.
 *
 * El gate de sesión evita que el número/estado se filtre a no autenticados;
 * la configuración de Zernio es global (env), así que no se usa el accountId.
 */
export async function GET() {
  try {
    await getCurrentAccount()
    const status = await getZernioConnectionStatus()
    return NextResponse.json(status)
  } catch (err) {
    return toErrorResponse(err)
  }
}
