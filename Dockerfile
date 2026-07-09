# wacrm (clinic-os-lite-new) — imagen de deploy para el VPS de pruebas.
# Dockerfile determinista (evita el flake de Nixpacks con el pin de nixpkgs).
# Dokploy inyecta las env vars del servicio como ENV en el build, así que los
# NEXT_PUBLIC_* quedan inlineados por `next build`.
FROM node:22-slim

WORKDIR /app

# deps primero (capa cacheable)
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# Vars build-time. Dokploy pasa el env del servicio como --build-arg; hay que
# declararlas como ARG→ENV o `next build` no las ve (los NEXT_PUBLIC_* se
# inlinean, y algunas páginas instancian el cliente Supabase al prerender).
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ARG NEXT_PUBLIC_SITE_URL
ARG SUPABASE_SERVICE_ROLE_KEY
ARG ENCRYPTION_KEY
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL \
    NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY \
    NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL \
    SUPABASE_SERVICE_ROLE_KEY=$SUPABASE_SERVICE_ROLE_KEY \
    ENCRYPTION_KEY=$ENCRYPTION_KEY

# código + build
COPY . .
RUN npm run build

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["npm", "start"]
