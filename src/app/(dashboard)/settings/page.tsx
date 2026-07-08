'use client';

import { useMemo, type ReactNode } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

import { useAuth } from '@/hooks/use-auth';
import { useTheme } from '@/hooks/use-theme';
import { SettingsRail } from '@/components/settings/settings-rail';
import { SettingsOverview } from '@/components/settings/settings-overview';
import { ProfileForm } from '@/components/settings/profile-form';
import { SecurityPanel } from '@/components/settings/security-panel';
import { AppearancePanel } from '@/components/settings/appearance-panel';
import { WhatsAppConfig } from '@/components/settings/whatsapp-config';
import { ZernioConnection } from '@/components/settings/zernio-connection';
import { GoogleIntegration } from '@/components/settings/google-integration';
import { TemplateManager } from '@/components/settings/template-manager';
import { FieldsAndTagsPanel } from '@/components/settings/fields-and-tags-panel';
import { DealsSettings } from '@/components/settings/deals-settings';
import { MembersTab } from '@/components/settings/members-tab';
import { ApiKeysSettings } from '@/components/settings/api-keys-settings';
import {
  resolveSection,
  type SettingsSection,
} from '@/components/settings/settings-sections';

export default function SettingsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { defaultCurrency } = useAuth();
  const { mode } = useTheme();

  // The URL (`?tab=`) is the single source of truth for the active
  // section — deep-linkable, and it keeps the existing links in the
  // app sidebar/header working. Legacy tab values (tags, custom-fields)
  // resolve onto their new home; unknown/empty → the Overview landing.
  const section = resolveSection(searchParams.get('tab'));

  const go = (next: SettingsSection) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set('tab', next);
    router.replace(`/settings?${params.toString()}`, { scroll: false });
  };

  // Cheap, fetch-free rail hints. The Overview landing carries the
  // full live status/counts; the rail just surfaces the two that are
  // already in context.
  const hints: Partial<Record<SettingsSection, ReactNode>> = useMemo(
    () => ({
      appearance: mode.charAt(0).toUpperCase() + mode.slice(1),
      deals: defaultCurrency,
    }),
    [mode, defaultCurrency],
  );

  const panel: Record<SettingsSection, ReactNode> = {
    overview: <SettingsOverview onSelect={go} />,
    profile: <ProfileForm />,
    security: <SecurityPanel />,
    appearance: <AppearancePanel />,
    whatsapp: (
      <div className="space-y-8">
        {/* Zernio es la vía real de WhatsApp hoy → validación en vivo arriba. */}
        <ZernioConnection />
        {/* La conexión directa con Meta queda como configuración avanzada
            (aún es un camino de respaldo del envío), plegada para no
            confundir con la conexión principal por Zernio. */}
        <details className="group max-w-2xl overflow-hidden rounded-lg border border-border">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-4 py-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted/40">
            <span>Configuración avanzada · conexión directa con Meta</span>
            <span className="text-xs text-muted-foreground/70 group-open:hidden">
              Mostrar
            </span>
            <span className="hidden text-xs text-muted-foreground/70 group-open:inline">
              Ocultar
            </span>
          </summary>
          <div className="border-t border-border p-4">
            <WhatsAppConfig />
          </div>
        </details>
      </div>
    ),
    integrations: <GoogleIntegration />,
    templates: <TemplateManager />,
    fields: <FieldsAndTagsPanel />,
    deals: <DealsSettings />,
    members: <MembersTab />,
    api: <ApiKeysSettings />,
  };

  return (
    <div>
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">
          Settings
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Everything in one place — your account and your workspace. Pick a
          section to manage it.
        </p>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[236px_minmax(0,1fr)] lg:items-start">
        <SettingsRail active={section} onSelect={go} hints={hints} />
        <div className="min-w-0">{panel[section]}</div>
      </div>
    </div>
  );
}
