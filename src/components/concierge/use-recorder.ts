'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

// ============================================================
// Grabación de dictado para el Concierge: MediaRecorder + AnalyserNode.
//
// Expone nivel de audio (para las barras del composer) y un VAD simple
// para el modo voz: si ya se escuchó voz y luego hay silencio sostenido,
// dispara onAutoStop (la página decide aceptar la grabación). El tope
// duro de duración también pasa por onAutoStop para que la página nunca
// pierda una grabación a medias.
// ============================================================

/** Tope duro de un dictado. */
const MAX_RECORDING_MS = 2 * 60 * 1000;
/** Muestreo del monitor (nivel + VAD). */
const MONITOR_INTERVAL_MS = 100;
/** RMS mínimo para considerar que hay voz. */
const SPEECH_RMS = 0.045;

const MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];

export interface RecorderStartOpts {
  /** Llamado UNA vez cuando el VAD (silencio sostenido) o el tope de
   *  2 min piden cerrar la grabación. El llamador debe hacer stop(). */
  onAutoStop?: () => void;
  /** Activa el VAD: ms de silencio (tras haber oído voz) para auto-stop.
   *  Omitido = sin VAD (dictado manual). */
  silenceStopMs?: number;
}

export function useRecorder() {
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [level, setLevel] = useState(0);

  const recRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const monitorRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const supported =
    typeof window !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia &&
    'MediaRecorder' in window;

  const teardown = useCallback(() => {
    if (monitorRef.current) {
      clearInterval(monitorRef.current);
      monitorRef.current = null;
    }
    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    recRef.current = null;
    setRecording(false);
    setSeconds(0);
    setLevel(0);
  }, []);

  useEffect(() => teardown, [teardown]);

  /** Inicia la grabación. false = sin permiso de micrófono / no soportado. */
  const start = useCallback(
    async (opts: RecorderStartOpts = {}): Promise<boolean> => {
      if (!supported || recRef.current) return false;

      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch {
        return false;
      }
      streamRef.current = stream;

      const mime = MIME_CANDIDATES.find((t) => MediaRecorder.isTypeSupported(t));
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      chunksRef.current = [];
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      rec.start(250);
      recRef.current = rec;
      setRecording(true);

      // Monitor de nivel + VAD. AudioContext puede no existir en tests.
      let analyser: AnalyserNode | null = null;
      let data: Uint8Array<ArrayBuffer> | null = null;
      try {
        const ctx = new AudioContext();
        audioCtxRef.current = ctx;
        const src = ctx.createMediaStreamSource(stream);
        analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        src.connect(analyser);
        data = new Uint8Array(new ArrayBuffer(analyser.fftSize));
      } catch {
        // sin monitor: la grabación sigue, solo sin barras ni VAD
      }

      const startedAt = Date.now();
      let heardSpeech = false;
      let lastVoiceAt = startedAt;
      let autoStopFired = false;
      const fireAutoStop = () => {
        if (autoStopFired) return;
        autoStopFired = true;
        opts.onAutoStop?.();
      };

      monitorRef.current = setInterval(() => {
        const elapsed = Date.now() - startedAt;
        setSeconds(Math.floor(elapsed / 1000));

        if (analyser && data) {
          analyser.getByteTimeDomainData(data);
          let sum = 0;
          for (let i = 0; i < data.length; i++) {
            const v = (data[i] - 128) / 128;
            sum += v * v;
          }
          const rms = Math.sqrt(sum / data.length);
          setLevel(Math.min(1, rms * 5));

          if (opts.silenceStopMs) {
            const now = Date.now();
            if (rms > SPEECH_RMS) {
              heardSpeech = true;
              lastVoiceAt = now;
            } else if (heardSpeech && now - lastVoiceAt > opts.silenceStopMs) {
              fireAutoStop();
            }
          }
        }

        if (elapsed > MAX_RECORDING_MS) fireAutoStop();
      }, MONITOR_INTERVAL_MS);

      return true;
    },
    [supported],
  );

  /** Cierra la grabación y devuelve el blob (null si quedó vacía). */
  const stop = useCallback((): Promise<Blob | null> => {
    return new Promise((resolve) => {
      const rec = recRef.current;
      if (!rec || rec.state === 'inactive') {
        teardown();
        resolve(null);
        return;
      }
      rec.onstop = () => {
        const type = rec.mimeType || 'audio/webm';
        const blob = new Blob(chunksRef.current, { type });
        chunksRef.current = [];
        teardown();
        resolve(blob.size > 0 ? blob : null);
      };
      rec.stop();
    });
  }, [teardown]);

  /** Descarta la grabación en curso. */
  const cancel = useCallback(() => {
    const rec = recRef.current;
    if (rec && rec.state !== 'inactive') {
      rec.onstop = () => teardown();
      try {
        rec.stop();
      } catch {
        teardown();
      }
    } else {
      teardown();
    }
    chunksRef.current = [];
  }, [teardown]);

  return { supported, recording, seconds, level, start, stop, cancel };
}
