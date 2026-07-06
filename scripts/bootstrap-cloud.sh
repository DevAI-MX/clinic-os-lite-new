#!/usr/bin/env bash
#
# bootstrap-cloud.sh — conecta clinicOS a un proyecto Supabase en la nube
# y lo deja listo, SIN Docker. Es la ruta recomendada: mismo stack que
# producción (VPS + Supabase), Auth/Storage/Realtime reales.
#
# Antes de correrlo:
#   1. Crea un proyecto gratis en https://supabase.com  (elige región
#      cercana, ej. "East US" o "South America (São Paulo)").
#   2. En el dashboard del proyecto anota:
#        - Project Ref   (Settings → General → Reference ID, ej. abcd1234)
#        - Database password (la que pusiste al crear el proyecto)
#        - Project URL   (Settings → API → Project URL)
#        - anon key       (Settings → API → Project API keys → anon public)
#        - service_role   (Settings → API → Project API keys → service_role)
#
# Uso:
#   bash scripts/bootstrap-cloud.sh <PROJECT_REF> <DB_PASSWORD>
#
# Luego pega en .env.local (te lo recuerda al final):
#   NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY,
#   SUPABASE_SERVICE_ROLE_KEY
#
set -euo pipefail
cd "$(dirname "$0")/.."

REF="${1:-}"
DB_PASS="${2:-}"
info() { printf '\033[36m▸ %s\033[0m\n' "$1"; }
ok()   { printf '\033[32m✓ %s\033[0m\n' "$1"; }
die()  { printf '\033[31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

[ -n "$REF" ] && [ -n "$DB_PASS" ] || die "Uso: bash scripts/bootstrap-cloud.sh <PROJECT_REF> <DB_PASSWORD>"

# 1. Vincular el proyecto local con el remoto.
info "Vinculando proyecto $REF…"
supabase link --project-ref "$REF" --password "$DB_PASS"
ok "Proyecto vinculado"

# 2. Aplicar TODAS las migraciones (001…031) al Postgres remoto.
#    supabase db push corre contra la BD remota — no necesita Docker.
info "Aplicando migraciones (incluye el dominio clínico 031)…"
supabase db push
ok "Esquema aplicado en la nube"

cat <<EOF

$(ok "Base lista.")
  Ahora pega en .env.local (Settings → API del dashboard):
    NEXT_PUBLIC_SUPABASE_URL=https://$REF.supabase.co
    NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon public key>
    SUPABASE_SERVICE_ROLE_KEY=<service_role key>

  Después siembra datos demo y arranca:
    npm run seed:demo
    npm run dev        →  http://localhost:3000
    Entra con:  covarrubiasmataemiliano@gmail.com / clinicos123
EOF
