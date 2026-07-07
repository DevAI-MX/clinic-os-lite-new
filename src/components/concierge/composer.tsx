'use client';

import { useRef } from 'react';
import { Loader2, Send } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  sending: boolean;
}

export function Composer({ value, onChange, onSend, sending }: ComposerProps) {
  const ref = useRef<HTMLTextAreaElement>(null);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onSend();
    }
  };

  // Autosize simple: crece con el contenido hasta ~5 líneas.
  const handleInput = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  };

  return (
    <div className="border-t border-border bg-background p-3">
      <div className="mx-auto flex w-full max-w-3xl items-end gap-2">
        <textarea
          ref={ref}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          onInput={handleInput}
          placeholder="Pregunta por tu agenda, anticipos, embudo… o pide una acción"
          rows={1}
          className="flex-1 resize-none rounded-xl border border-border bg-muted px-4 py-2.5 text-sm text-foreground placeholder:text-muted-foreground outline-none focus:border-primary/50"
        />
        <Button
          size="sm"
          onClick={onSend}
          disabled={!value.trim() || sending}
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
    </div>
  );
}
