'use client';

import { useEffect, useRef, useState } from 'react';
import {
  Check,
  FileText,
  Loader2,
  Mic,
  Paperclip,
  Send,
  X,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

// ============================================================
// Composer del Concierge: texto + adjuntos (botón, pegar, arrastrar)
// + dictado por voz. Durante la grabación la fila del textarea se
// transforma en el estado "grabando" (punto rojo, barras de nivel,
// timer, cancelar/aceptar). El estado de adjuntos y de voz vive en la
// página (los necesita el modo voz); aquí solo se pinta y se delega.
// ============================================================

export interface StagedAttachment {
  id: string;
  name: string;
  mime: string;
  /** Presente cuando terminó de subir al bucket. */
  url?: string;
  /** Path en storage (para GC si se quita antes de enviar). */
  path?: string;
  uploading: boolean;
}

export type VoiceState = 'idle' | 'recording' | 'transcribing';

interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  sending: boolean;
  attachments: StagedAttachment[];
  onAddFiles: (files: File[]) => void;
  onRemoveAttachment: (id: string) => void;
  voiceState: VoiceState;
  voiceSupported: boolean;
  recordSeconds: number;
  recordLevel: number;
  onMicStart: () => void;
  onMicCancel: () => void;
  onMicAccept: () => void;
}

const ACCEPTED_MIMES = 'image/jpeg,image/png,image/webp,application/pdf';

function fmtTimer(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Barras de nivel del mic — 5 barras escaladas por el nivel actual. */
function LevelBars({ level }: { level: number }) {
  const scales = [0.45, 0.8, 1, 0.7, 0.5];
  return (
    <div className="flex h-6 items-center gap-0.5" aria-hidden>
      {scales.map((s, i) => (
        <span
          key={i}
          className="w-1 rounded-full bg-destructive transition-[height] duration-100"
          style={{ height: `${Math.max(15, Math.min(100, level * 100 * s + 12))}%` }}
        />
      ))}
    </div>
  );
}

export function Composer({
  value,
  onChange,
  onSend,
  sending,
  attachments,
  onAddFiles,
  onRemoveAttachment,
  voiceState,
  voiceSupported,
  recordSeconds,
  recordLevel,
  onMicStart,
  onMicCancel,
  onMicAccept,
}: ComposerProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  const uploading = attachments.some((a) => a.uploading);
  const canSend =
    !sending &&
    !uploading &&
    voiceState === 'idle' &&
    (value.trim().length > 0 || attachments.some((a) => a.url));

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onSend();
    }
  };

  // Esc cancela la grabación desde cualquier lado.
  useEffect(() => {
    if (voiceState !== 'recording') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onMicCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [voiceState, onMicCancel]);

  // Autosize simple: crece con el contenido hasta ~5 líneas.
  const handleInput = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    const files = Array.from(e.clipboardData?.files ?? []);
    if (files.length > 0) {
      e.preventDefault();
      onAddFiles(files);
    }
  };

  return (
    <div
      className={cn(
        'border-t border-border bg-background p-3',
        dragOver && 'bg-primary/5',
      )}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        const files = Array.from(e.dataTransfer?.files ?? []);
        if (files.length > 0) onAddFiles(files);
      }}
    >
      <div className="mx-auto w-full max-w-3xl">
        {attachments.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {attachments.map((a) => (
              <div
                key={a.id}
                className="flex max-w-56 items-center gap-1.5 rounded-lg border border-border bg-card px-2 py-1.5 text-xs"
              >
                {a.uploading ? (
                  <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
                ) : a.mime.startsWith('image/') && a.url ? (
                  <img
                    src={a.url}
                    alt=""
                    className="h-6 w-6 shrink-0 rounded object-cover"
                  />
                ) : (
                  <FileText className="h-3.5 w-3.5 shrink-0 text-primary" />
                )}
                <span className="truncate text-foreground">{a.name}</span>
                <button
                  type="button"
                  onClick={() => onRemoveAttachment(a.id)}
                  className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
                  aria-label={`Quitar ${a.name}`}
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}

        {voiceState === 'recording' ? (
          <div className="flex items-center gap-3 rounded-xl border border-destructive/40 bg-destructive/5 px-4 py-2">
            <span className="h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-destructive" />
            <LevelBars level={recordLevel} />
            <span className="nums text-sm text-foreground">{fmtTimer(recordSeconds)}</span>
            <span className="hidden flex-1 truncate text-xs text-muted-foreground sm:block">
              Escuchando… suelta tu pregunta y acepta para enviar.
            </span>
            <div className="ml-auto flex items-center gap-1">
              <Button
                size="sm"
                variant="ghost"
                onClick={onMicCancel}
                className="h-9 w-9 p-0"
                aria-label="Cancelar grabación"
              >
                <X className="h-4 w-4" />
              </Button>
              <Button
                size="sm"
                onClick={onMicAccept}
                className="h-9 w-9 p-0"
                aria-label="Usar grabación"
              >
                <Check className="h-4 w-4" />
              </Button>
            </div>
          </div>
        ) : voiceState === 'transcribing' ? (
          <div className="flex items-center gap-2 rounded-xl border border-border bg-muted px-4 py-3 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Transcribiendo…
          </div>
        ) : (
          <div className="flex items-end gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept={ACCEPTED_MIMES}
              multiple
              className="hidden"
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []);
                if (files.length > 0) onAddFiles(files);
                e.target.value = '';
              }}
            />
            <Button
              size="sm"
              variant="ghost"
              onClick={() => fileInputRef.current?.click()}
              disabled={sending}
              className="h-10 w-10 shrink-0 p-0 text-muted-foreground"
              aria-label="Adjuntar archivo"
            >
              <Paperclip className="h-4 w-4" />
            </Button>
            <textarea
              ref={ref}
              value={value}
              onChange={(e) => onChange(e.target.value)}
              onKeyDown={handleKeyDown}
              onInput={handleInput}
              onPaste={handlePaste}
              placeholder="Pregunta por tu agenda, anticipos, embudo… o pide una acción"
              rows={1}
              className="flex-1 resize-none rounded-xl border border-border bg-muted px-4 py-2.5 text-sm text-foreground placeholder:text-muted-foreground outline-none focus:border-primary/50"
            />
            {voiceSupported && (
              <Button
                size="sm"
                variant="ghost"
                onClick={onMicStart}
                disabled={sending}
                className="h-10 w-10 shrink-0 p-0 text-muted-foreground"
                aria-label="Dictar por voz"
              >
                <Mic className="h-4 w-4" />
              </Button>
            )}
            <Button
              size="sm"
              onClick={onSend}
              disabled={!canSend}
              className="h-10 w-10 shrink-0 p-0"
              aria-label="Enviar"
            >
              {sending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
