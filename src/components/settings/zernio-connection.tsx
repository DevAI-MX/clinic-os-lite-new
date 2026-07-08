'use client';

// ============================================================
// ZernioConnection — Settings → WhatsApp
//
// El WhatsApp de la clínica se conecta a través de Zernio (envío +
// recepción). Esta tarjeta VALIDA EN VIVO esa conexión: pega a
// /api/zernio/status, que a su vez consulta la API de Zernio con la
// API key. Muestra el número conectado, el nombre verificado, la
// calidad de Meta y el tope de mensajería — o el motivo exacto por
// el que no está válida (API key mala, cuenta equivocada, modo prueba).
// La conexión se administra en Zernio (env del servidor), no aquí.
// ============================================================

import { useCallback, useEffect, useState } from 'react';

import {
  AlertTriangle,
  BadgeCheck,
  CheckCircle2,
  Loader2,
  MessageSquare,
  Phone,
  RotateCcw,
  XCircle,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { SettingsPanelHead } from './settings-panel-head';

type ZernioAccountInfo = {
  accountId: string;
  phoneNumber: string | null;
  verifiedName: string | null;
  displayName: string | null;
  platform: string | null;
  qualityRating: string | null;
  messagingTier: string | null;
  enabled: boolean;
  isActive: boolean;
  connectedAt: string | null;
  disconnectedAt: string | null;
};

type ZernioStatus =
  | { state: 'valid'; account: ZernioAccountInfo }
  | { state: 'dry_run' }
  | { state: 'not_configured' }
  | { state: 'unauthorized' }
  | { state: 'account_not_found'; accountId: string }
  | { state: 'error'; message: string };

/** Color del chip de calidad según la calificación de Meta. */
function qualityChipClass(rating: string | null): string {
  switch ((rating ?? '').toUpperCase()) {
    case 'GREEN':
      return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300';
    case 'YELLOW':
      return 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300';
    case 'RED':
      return 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300';
    default:
      return 'border-border bg-muted text-muted-foreground';
  }
}

function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('es-MX', { year: 'numeric', month: 'short', day: 'numeric' });
}

export function ZernioConnection() {
  const [status, setStatus] = useState<ZernioStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [revalidating, setRevalidating] = useState(false);

  const loadStatus = useCallback(async (isRevalidate = false) => {
    if (isRevalidate) setRevalidating(true);
    try {
      const res = await fetch('/api/zernio/status', { cache: 'no-store' });
      if (!res.ok) throw new Error('status');
      setStatus((await res.json()) as ZernioStatus);
    } catch {
      setStatus({ state: 'error', message: 'No se pudo leer el estado de Zernio.' });
    } finally {
      setLoading(false);
      setRevalidating(false);
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const isValid = status?.state === 'valid';

  return (
    <section className="max-w-2xl animate-in fade-in-50 space-y-6 duration-200">
      <SettingsPanelHead
        title="WhatsApp"
        description="Tu número de WhatsApp está conectado a través de Zernio (envío y recepción). Aquí validamos, en vivo, que la conexión sigue activa."
      />

      <Card>
        <CardContent className="space-y-4">
          <div className="flex items-start gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
              <MessageSquare className="size-5" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-foreground">
                WhatsApp por Zernio
              </p>
              <p className="text-xs text-muted-foreground">
                La conexión se administra en Zernio. Si validas y falla, revisa
                la cuenta y la API key en el panel de Zernio.
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void loadStatus(true)}
              disabled={loading || revalidating}
              className="shrink-0"
            >
              {revalidating ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <RotateCcw className="size-4" />
              )}
              Revalidar
            </Button>
          </div>

          {loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Validando conexión con Zernio…
            </div>
          ) : isValid && status.state === 'valid' ? (
            <div className="space-y-3">
              {/* Veredicto */}
              <div className="flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-sm font-medium text-emerald-700 dark:text-emerald-300">
                  <CheckCircle2 className="size-4" />
                  Conectado y validado
                </span>
                {!status.account.isActive || !status.account.enabled ? (
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-xs font-medium text-amber-700 dark:text-amber-300">
                    <AlertTriangle className="size-3.5" />
                    Cuenta inactiva en Zernio
                  </span>
                ) : null}
              </div>

              {/* Número + nombre verificado */}
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                <span className="inline-flex items-center gap-2 text-base font-semibold text-foreground">
                  <Phone className="size-4 text-muted-foreground" />
                  {status.account.phoneNumber ?? 'Número no reportado'}
                </span>
                {status.account.verifiedName ? (
                  <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
                    <BadgeCheck className="size-4 text-emerald-500" />
                    {status.account.verifiedName}
                  </span>
                ) : null}
              </div>

              {/* Chips: calidad, tope, conexión */}
              <div className="flex flex-wrap gap-2 text-xs">
                {status.account.qualityRating ? (
                  <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-medium ${qualityChipClass(status.account.qualityRating)}`}>
                    Calidad: {status.account.qualityRating}
                  </span>
                ) : null}
                {status.account.messagingTier ? (
                  <span className="inline-flex items-center gap-1 rounded-full border border-border bg-muted px-2 py-0.5 font-medium text-muted-foreground">
                    Tope: {status.account.messagingTier.replace('TIER_', '')}
                  </span>
                ) : null}
                {formatDate(status.account.connectedAt) ? (
                  <span className="inline-flex items-center gap-1 rounded-full border border-border bg-muted px-2 py-0.5 font-medium text-muted-foreground">
                    Conectado el {formatDate(status.account.connectedAt)}
                  </span>
                ) : null}
              </div>
            </div>
          ) : status?.state === 'dry_run' ? (
            <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
              <span className="font-medium">Modo prueba (dry-run).</span> Las
              respuestas se guardan en la conversación pero <span className="font-medium">no salen por WhatsApp</span>.
              Configura <code className="rounded bg-black/10 px-1 dark:bg-white/10">ZERNIO_API_KEY</code> y
              <code className="rounded bg-black/10 px-1 dark:bg-white/10"> ZERNIO_ACCOUNT_ID</code> (y quita
              <code className="rounded bg-black/10 px-1 dark:bg-white/10"> ZERNIO_DRY_RUN</code>) para conectar de verdad.
            </p>
          ) : status?.state === 'not_configured' ? (
            <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <span>
                Zernio no está configurado en el servidor (faltan
                <code className="rounded bg-black/10 px-1 dark:bg-white/10"> ZERNIO_API_KEY</code> /
                <code className="rounded bg-black/10 px-1 dark:bg-white/10"> ZERNIO_ACCOUNT_ID</code>).
                WhatsApp no enviará ni recibirá mensajes hasta configurarlo.
              </span>
            </div>
          ) : status?.state === 'unauthorized' ? (
            <div className="flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-300">
              <XCircle className="mt-0.5 size-4 shrink-0" />
              <span>
                <span className="font-medium">API key inválida.</span> Zernio
                rechazó las credenciales (401). Revisa
                <code className="rounded bg-black/10 px-1 dark:bg-white/10"> ZERNIO_API_KEY</code> en el
                servidor contra el panel de Zernio.
              </span>
            </div>
          ) : status?.state === 'account_not_found' ? (
            <div className="flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-300">
              <XCircle className="mt-0.5 size-4 shrink-0" />
              <span>
                La API key es válida, pero la cuenta configurada
                (<code className="rounded bg-black/10 px-1 dark:bg-white/10">{status.accountId}</code>) no
                aparece entre las cuentas de WhatsApp conectadas en Zernio.
                Revisa <code className="rounded bg-black/10 px-1 dark:bg-white/10">ZERNIO_ACCOUNT_ID</code>.
              </span>
            </div>
          ) : (
            <div className="flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-300">
              <XCircle className="mt-0.5 size-4 shrink-0" />
              <span>
                No se pudo validar la conexión con Zernio
                {status?.state === 'error' && status.message ? `: ${status.message}` : '.'}
              </span>
            </div>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
