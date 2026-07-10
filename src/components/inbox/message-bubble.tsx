"use client";

import { useState, useEffect, useCallback } from "react";
import { cn } from "@/lib/utils";
import type { Message, MessageReaction } from "@/types";
import {
  Clock,
  Check,
  CheckCheck,
  XCircle,
  FileText,
  MapPin,
  LayoutTemplate,
  ImageOff,
  CornerDownLeft,
  Download,
} from "lucide-react";
import { format } from "date-fns";
import { ReplyQuote } from "./reply-quote";
import { MessageReactions } from "./message-reactions";

interface MessageBubbleProps {
  message: Message;
  /** Pre-computed quote info for messages that reply to another. */
  reply?: { authorLabel: string; preview: string } | null;
  reactions?: MessageReaction[];
  currentUserId?: string;
  onToggleReaction?: (emoji: string) => void;
}

function StatusIcon({ status }: { status: Message["status"] }) {
  switch (status) {
    case "sending":
      return <Clock className="h-3 w-3 text-muted-foreground" />;
    case "sent":
      return <Check className="h-3 w-3 text-muted-foreground" />;
    case "delivered":
      return <CheckCheck className="h-3 w-3 text-muted-foreground" />;
    case "read":
      return <CheckCheck className="h-3 w-3 text-blue-400" />;
    case "failed":
      return <XCircle className="h-3 w-3 text-red-400" />;
    default:
      return null;
  }
}

function MediaUnavailable({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
      <ImageOff className="h-4 w-4 shrink-0 text-muted-foreground" />
      <span>{label} unavailable</span>
    </div>
  );
}

/**
 * Resolves a message's `media_url` into something a browser element can
 * actually load. Proxy URLs (`/api/whatsapp/media/...`, the Meta-direct
 * pipeline) need an authenticated `fetch` turned into a `blob:` URL —
 * a bare `src` attribute won't carry the session the route checks for.
 * Anything else (Supabase Storage public URLs, the common case since
 * Zernio attachments get rehosted there) is used as-is. Shared by
 * image/video/audio so all three get the same loading + error-state
 * behavior instead of each reinventing it.
 */
function useMediaSrc(url: string) {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!url) return;

    // Proxy URLs need auth fetch to create blob URL
    if (url.startsWith("/api/whatsapp/media/")) {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error("Failed to load media");
        const blob = await res.blob();
        setSrc(URL.createObjectURL(blob));
      } catch {
        setError(true);
      } finally {
        setLoading(false);
      }
    } else {
      setSrc(url);
      setLoading(false);
    }
  }, [url]);

  useEffect(() => {
    load();
    return () => {
      // Functional form so this reads the LATEST src at unmount time,
      // not the one captured when the effect was set up (which is
      // always null — load() hasn't resolved yet at that point).
      setSrc((current) => {
        if (current?.startsWith("blob:")) URL.revokeObjectURL(current);
        return current;
      });
    };
  }, [load]);

  return { src, error, loading, setError };
}

function MediaSpinner() {
  return (
    <div className="flex h-40 w-60 items-center justify-center rounded-lg bg-muted">
      <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
    </div>
  );
}

/** Nombre de archivo a partir del último segmento de la URL (los objetos
 *  re-hospedados en Supabase Storage ya traen extensión). */
function filenameFromUrl(url: string, fallback: string): string {
  try {
    const base = new URL(url).pathname.split("/").pop();
    return base && base.includes(".") ? base : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Fuerza la descarga vía blob en vez de un `<a download>` plano: los
 * navegadores ignoran el atributo `download` en enlaces de otro origen
 * (Supabase Storage, no el dominio del panel) y simplemente navegan.
 */
async function downloadMedia(url: string, filename: string) {
  try {
    const res = await fetch(url);
    const blob = await res.blob();
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = blobUrl;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(blobUrl);
  } catch {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

function DownloadOverlayButton({ url, filename }: { url: string; filename: string }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        void downloadMedia(url, filename);
      }}
      title="Download"
      className="absolute right-1.5 top-1.5 flex size-7 items-center justify-center rounded-full bg-black/50 text-white opacity-0 transition-opacity hover:bg-black/70 group-hover:opacity-100"
    >
      <Download className="size-3.5" />
    </button>
  );
}

function MediaImage({ url, alt }: { url: string; alt: string }) {
  const { src, error, loading, setError } = useMediaSrc(url);

  if (error) {
    return (
      <div className="flex h-40 w-60 items-center justify-center rounded-lg bg-muted">
        <ImageOff className="h-8 w-8 text-muted-foreground" />
      </div>
    );
  }

  if (loading) return <MediaSpinner />;

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="group relative block w-fit"
      title="View full size"
    >
      <img
        src={src ?? ""}
        alt={alt}
        className="max-h-64 max-w-60 rounded-lg object-cover"
        onError={() => setError(true)}
      />
      <DownloadOverlayButton url={url} filename={filenameFromUrl(url, "image.jpg")} />
    </a>
  );
}

function MediaVideo({ url }: { url: string }) {
  const { src, error, loading, setError } = useMediaSrc(url);

  if (error) return <MediaUnavailable label="Video" />;
  if (loading) return <MediaSpinner />;

  return (
    <div className="group relative w-fit">
      <video
        src={src ?? ""}
        controls
        className="max-h-64 max-w-60 rounded-lg"
        onError={() => setError(true)}
      />
      <DownloadOverlayButton url={url} filename={filenameFromUrl(url, "video.mp4")} />
    </div>
  );
}

function MediaAudio({ url }: { url: string }) {
  const { src, error, loading, setError } = useMediaSrc(url);

  if (error) return <MediaUnavailable label="Audio" />;
  if (loading) {
    return (
      <div className="flex h-10 w-60 items-center justify-center rounded-lg bg-muted">
        <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="flex w-fit items-center gap-1">
      <audio
        src={src ?? ""}
        controls
        preload="metadata"
        className="max-w-60"
        onError={() => setError(true)}
      />
      <button
        type="button"
        onClick={() => void downloadMedia(url, filenameFromUrl(url, "audio.ogg"))}
        title="Download"
        className="flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <Download className="size-3.5" />
      </button>
    </div>
  );
}

function MessageContent({ message }: { message: Message }) {
  switch (message.content_type) {
    case "text":
      return (
        <p className="whitespace-pre-wrap break-words text-sm">
          {message.content_text}
        </p>
      );

    case "image":
      return (
        <div>
          {message.media_url ? (
            <MediaImage url={message.media_url} alt="Shared image" />
          ) : (
            <MediaUnavailable label="Image" />
          )}
          {message.content_text && (
            <p className="mt-1 whitespace-pre-wrap break-words text-sm">
              {message.content_text}
            </p>
          )}
        </div>
      );

    case "video":
      return (
        <div>
          {message.media_url ? (
            <MediaVideo url={message.media_url} />
          ) : (
            <MediaUnavailable label="Video" />
          )}
          {message.content_text && (
            <p className="mt-1 whitespace-pre-wrap break-words text-sm">
              {message.content_text}
            </p>
          )}
        </div>
      );

    case "audio":
      return (
        <div>
          {message.media_url ? (
            <MediaAudio url={message.media_url} />
          ) : (
            <MediaUnavailable label="Audio" />
          )}
        </div>
      );

    case "document": {
      const documentUrl = message.media_url;
      if (!documentUrl) {
        return <MediaUnavailable label={message.content_text || "Document"} />;
      }
      return (
        <div className="flex items-center gap-1 rounded-lg bg-muted/50 pr-1 text-sm">
          <a
            href={documentUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2 hover:bg-muted"
          >
            <FileText className="h-5 w-5 shrink-0 text-muted-foreground" />
            <span className="truncate">
              {message.content_text || "Document"}
            </span>
          </a>
          <button
            type="button"
            onClick={() =>
              void downloadMedia(
                documentUrl,
                filenameFromUrl(documentUrl, message.content_text || "document"),
              )
            }
            title="Download"
            className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <Download className="h-4 w-4" />
          </button>
        </div>
      );
    }

    case "template":
      return (
        <div>
          <span className="mb-1 inline-flex items-center gap-1 rounded bg-primary/20 px-1.5 py-0.5 text-[10px] font-medium text-primary">
            <LayoutTemplate className="h-3 w-3" />
            Template
          </span>
          {message.content_text && (
            <p className="mt-1 whitespace-pre-wrap break-words text-sm">
              {message.content_text}
            </p>
          )}
        </div>
      );

    case "location":
      return (
        <div className="flex items-center gap-2 text-sm">
          <MapPin className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span>{message.content_text || "Location shared"}</span>
        </div>
      );

    case "interactive": {
      // Customer tapped a reply button or list row on a message the bot
      // sent. We show the tapped option's title (already in content_text,
      // set by parseMessageContent in the webhook) with a small affordance
      // so agents reading the inbox can tell at a glance that this is a
      // tap rather than the customer typing the same words.
      return (
        <div className="flex flex-col gap-0.5">
          <span className="inline-flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            <CornerDownLeft className="h-3 w-3" />
            Button reply
          </span>
          <p className="whitespace-pre-wrap break-words text-sm">
            {message.content_text || "[Interactive reply]"}
          </p>
        </div>
      );
    }

    default:
      return (
        <p className="whitespace-pre-wrap break-words text-sm">
          {message.content_text || "[Unsupported message type]"}
        </p>
      );
  }
}

export function MessageBubble({
  message,
  reply,
  reactions,
  currentUserId,
  onToggleReaction,
}: MessageBubbleProps) {
  const isAgent = message.sender_type === "agent" || message.sender_type === "bot";
  const time = format(new Date(message.created_at), "HH:mm");

  // Row alignment + width cap are owned by <MessageActions> so its hover
  // group matches the bubble's content area, not the full row.
  return (
    <div
      className={cn(
        "flex flex-col",
        isAgent ? "items-end" : "items-start",
      )}
    >
      <div
        className={cn(
          "relative rounded-2xl px-3 py-2",
          isAgent
            ? "rounded-br-md bg-primary text-primary-foreground"
            : "rounded-bl-md bg-muted text-foreground",
        )}
      >
        {reply && (
          <ReplyQuote
            authorLabel={reply.authorLabel}
            preview={reply.preview}
            onPrimary={isAgent}
          />
        )}
        <MessageContent message={message} />
        <div
          className={cn(
            "mt-1 flex items-center gap-1",
            isAgent ? "justify-end" : "justify-start",
          )}
        >
          <span
            className={cn(
              "text-[10px]",
              // Outbound bubbles sit on the primary fill, so the
              // timestamp must read against that (not the neutral
              // foreground) — otherwise it goes low-contrast in light
              // mode. Inbound bubbles use the muted surface.
              isAgent ? "text-primary-foreground/70" : "text-muted-foreground",
            )}
          >
            {time}
          </span>
          {isAgent && <StatusIcon status={message.status} />}
        </div>
      </div>
      {reactions && reactions.length > 0 && onToggleReaction && (
        <MessageReactions
          reactions={reactions}
          currentUserId={currentUserId}
          onToggle={onToggleReaction}
        />
      )}
    </div>
  );
}
