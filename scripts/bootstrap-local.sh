#!/usr/bin/env bash
#
# bootstrap-local.sh — levanta clinicOS en local de punta a punta.
#
#   1. Verifica que Docker esté corriendo (Colima o Docker Desktop).
#   2. `supabase start` → Postgres + Auth + Storage locales y aplica
#      TODAS las migraciones de supabase/migrations (incluida la 031
#      del dominio clínico).
#   3. Inyecta las llaves locales (anon + service_role) en .env.local
#      y apunta la URL de Supabase al stack local.
#   4. Siembra datos demo (usuario, catálogo, contactos, citas).
#   5. Te deja listo para `npm run dev`.
#
# Uso:  bash scripts/bootstrap-local.sh
#
set -euo pipefail
cd "$(dirname "$0")/.."
ENV_FILE=".env.local"

info() { printf '\033[36m▸ %s\033[0m\n' "$1"; }
ok()   { printf '\033[32m✓ %s\033[0m\n' "$1"; }
die()  { printf '\033[31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

# --- 1. Docker ------------------------------------------------------
if ! docker info >/dev/null 2>&1; then
  die "Docker no está corriendo. Arráncalo con:  colima start   (o abre Docker Desktop)"
fi
ok "Docker disponible"

# --- 2. Supabase local ----------------------------------------------
info "Levantando Supabase local (puede tardar la primera vez: baja imágenes)…"
supabase start

# Lee las llaves del stack local.
STATUS_JSON="$(supabase status -o json)"
SUPA_URL="$(printf '%s' "$STATUS_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);process.stdout.write(j.API_URL||j.api_url||"http://127.0.0.1:54321")})')"
ANON="$(printf '%s' "$STATUS_JSON"   | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);process.stdout.write(j.ANON_KEY||j.anon_key)})')"
SERVICE="$(printf '%s' "$STATUS_JSON"| node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);process.stdout.write(j.SERVICE_ROLE_KEY||j.service_role_key)})')"
[ -n "$ANON" ] && [ -n "$SERVICE" ] || die "No pude leer las llaves de 'supabase status'"
ok "Supabase local arriba en $SUPA_URL"

# --- 3. .env.local --------------------------------------------------
info "Escribiendo llaves locales en $ENV_FILE"
# Reemplaza (o agrega) las tres variables de Supabase, dejando el resto intacto.
node - "$ENV_FILE" "$SUPA_URL" "$ANON" "$SERVICE" <<'NODE'
const fs = require("fs");
const [file, url, anon, service] = process.argv.slice(2);
let text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
const set = (k, v) => {
  const re = new RegExp(`^${k}=.*$`, "m");
  if (re.test(text)) text = text.replace(re, `${k}=${v}`);
  else text += `\n${k}=${v}`;
};
set("NEXT_PUBLIC_SUPABASE_URL", url);
set("NEXT_PUBLIC_SUPABASE_ANON_KEY", anon);
set("SUPABASE_SERVICE_ROLE_KEY", service);
fs.writeFileSync(file, text.replace(/\n{3,}/g, "\n\n").trimStart() + "\n");
NODE
ok "$ENV_FILE actualizado"

# --- 4. Seed --------------------------------------------------------
info "Sembrando datos demo…"
node scripts/seed-demo.mjs

# --- 5. Listo -------------------------------------------------------
printf '\n'
ok "clinicOS listo en local."
cat <<EOF

  Arranca el panel:      npm run dev
  Ábrelo en:             http://localhost:3000
  Entra con:             covarrubiasmataemiliano@gmail.com / clinicos123
  Studio de la BD:       http://localhost:54323

  Para apagar Supabase:  supabase stop
EOF
