'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

// ============================================================
// Reproducción de voz del Concierge. Primera opción: el endpoint
// /api/ai/concierge/tts (OpenAI, voz del producto). Si la cuenta no
// tiene key OpenAI o el fetch falla, cae a speechSynthesis del
// navegador. Cola de UNO: hablar algo nuevo detiene lo anterior.
// `onEnd` solo dispara cuando la reproducción termina de forma natural
// (no al detenerla ni al ser reemplazada) — es lo que encadena el modo
// voz (respuesta → volver a escuchar).
// ============================================================

/** Limpieza mínima para el fallback del navegador (el endpoint ya
 *  limpia server-side). */
function stripForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[*_#`>]+/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

export function useTts() {
  const [playingId, setPlayingId] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);
  // Cada speak() incrementa la secuencia; callbacks de reproducciones
  // viejas quedan inertes.
  const seqRef = useRef(0);

  const stop = useCallback(() => {
    seqRef.current += 1;
    audioRef.current?.pause();
    audioRef.current = null;
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    }
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
    setPlayingId(null);
  }, []);

  useEffect(() => stop, [stop]);

  const speak = useCallback(
    async (id: string, text: string, opts: { onEnd?: () => void } = {}) => {
      stop();
      const seq = seqRef.current;
      setPlayingId(id);

      const finishNatural = () => {
        if (seq !== seqRef.current) return;
        setPlayingId(null);
        if (urlRef.current) {
          URL.revokeObjectURL(urlRef.current);
          urlRef.current = null;
        }
        audioRef.current = null;
        opts.onEnd?.();
      };

      const fallbackBrowser = () => {
        if (seq !== seqRef.current) return;
        const synth =
          typeof window !== 'undefined' && 'speechSynthesis' in window
            ? window.speechSynthesis
            : null;
        if (!synth) {
          finishNatural();
          return;
        }
        const utterance = new SpeechSynthesisUtterance(stripForSpeech(text));
        utterance.lang = 'es-MX';
        utterance.onend = finishNatural;
        utterance.onerror = finishNatural;
        synth.speak(utterance);
      };

      try {
        const res = await fetch('/api/ai/concierge/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text }),
        });
        if (seq !== seqRef.current) return;
        if (!res.ok) {
          fallbackBrowser();
          return;
        }
        const blob = await res.blob();
        if (seq !== seqRef.current) return;
        const url = URL.createObjectURL(blob);
        urlRef.current = url;
        const audio = new Audio(url);
        audioRef.current = audio;
        audio.onended = finishNatural;
        audio.onerror = finishNatural;
        await audio.play();
      } catch {
        fallbackBrowser();
      }
    },
    [stop],
  );

  return { playingId, speak, stop };
}
