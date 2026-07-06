"use client";

/**
 * ContactCombobox — buscador de contactos por nombre o teléfono para el
 * formulario de nueva cita. Autocontenido (input + lista desplegable)
 * para funcionar sin fricción dentro de un Dialog.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Loader2, Search, User, X } from "lucide-react";
import type { AppointmentContact } from "@/lib/clinic/types";

interface ContactComboboxProps {
  value: AppointmentContact | null;
  onSelect: (contact: AppointmentContact | null) => void;
  autoFocus?: boolean;
}

export function ContactCombobox({
  value,
  onSelect,
  autoFocus = false,
}: ContactComboboxProps) {
  const supabase = createClient();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<AppointmentContact[]>([]);
  const [open, setOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const searchSeq = useRef(0);

  const search = useCallback(
    async (term: string) => {
      const seq = ++searchSeq.current;
      setSearching(true);
      let queryBuilder = supabase
        .from("contacts")
        .select("id, name, phone")
        .limit(8);
      const trimmed = term.trim();
      if (trimmed) {
        const like = `%${trimmed}%`;
        queryBuilder = queryBuilder.or(
          `name.ilike.${like},phone.ilike.${like}`,
        );
      } else {
        // Sin término: los contactos más recientes como sugerencia.
        queryBuilder = queryBuilder.order("created_at", { ascending: false });
      }
      const { data } = await queryBuilder;
      if (seq !== searchSeq.current) return; // respuesta vieja
      setResults((data ?? []) as AppointmentContact[]);
      setSearching(false);
    },
    [supabase],
  );

  // Búsqueda con debounce mientras el dropdown está abierto.
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => search(query), 250);
    return () => clearTimeout(t);
  }, [open, query, search]);

  // Cerrar al hacer click fuera.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  if (value) {
    return (
      <div className="flex items-center justify-between gap-2 rounded-lg border border-border bg-muted px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <User className="size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-foreground">
              {value.name || "Sin nombre"}
            </p>
            <p className="nums truncate text-xs text-muted-foreground">
              {value.phone}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => {
            onSelect(null);
            setQuery("");
          }}
          aria-label="Quitar contacto"
          className="text-muted-foreground transition-colors hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="relative">
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          autoFocus={autoFocus}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setOpen(false);
          }}
          placeholder="Buscar por nombre o teléfono…"
          className="bg-muted pl-8 text-foreground placeholder:text-muted-foreground"
          role="combobox"
          aria-expanded={open}
        />
        {searching && (
          <Loader2 className="absolute right-2.5 top-1/2 size-4 -translate-y-1/2 animate-spin text-muted-foreground" />
        )}
      </div>

      {open && (
        <div className="absolute z-50 mt-1 w-full overflow-hidden rounded-lg border border-border bg-popover shadow-lifted">
          {results.length === 0 ? (
            <p className="px-3 py-3 text-center text-sm text-muted-foreground">
              {searching
                ? "Buscando…"
                : query.trim()
                  ? "Sin resultados. Crea el contacto en Contactos."
                  : "Escribe para buscar contactos."}
            </p>
          ) : (
            <ul className="max-h-56 overflow-y-auto py-1">
              {results.map((contact) => (
                <li key={contact.id}>
                  <button
                    type="button"
                    onClick={() => {
                      onSelect(contact);
                      setOpen(false);
                    }}
                    className={cn(
                      "flex w-full items-center gap-2 px-3 py-1.5 text-left",
                      "hover:bg-muted/60",
                    )}
                  >
                    <User className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0">
                      <span className="block truncate text-sm text-popover-foreground">
                        {contact.name || "Sin nombre"}
                      </span>
                      <span className="nums block truncate text-xs text-muted-foreground">
                        {contact.phone}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
