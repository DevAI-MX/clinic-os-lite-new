'use client';

import { FileText } from 'lucide-react';
import type { ConciergeAttachment } from './use-concierge-chat';

// ============================================================
// Adjuntos dentro del transcript: imágenes como miniaturas clicables
// (abren el original en otra pestaña) y PDFs como chip con icono.
// ============================================================

export function AttachmentView({ attachment }: { attachment: ConciergeAttachment }) {
  if (attachment.mime.startsWith('image/')) {
    return (
      <a
        href={attachment.url}
        target="_blank"
        rel="noopener noreferrer"
        className="block overflow-hidden rounded-xl border border-border"
        title={attachment.name}
      >
        <img
          src={attachment.url}
          alt={attachment.name}
          className="max-h-48 w-auto max-w-full object-cover"
          loading="lazy"
        />
      </a>
    );
  }
  return (
    <a
      href={attachment.url}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs text-foreground hover:border-primary/40"
    >
      <FileText className="h-3.5 w-3.5 shrink-0 text-primary" />
      <span className="truncate">{attachment.name}</span>
    </a>
  );
}
