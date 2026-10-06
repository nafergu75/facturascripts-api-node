#!/usr/bin/env bash
# Pone (o cambia) la contrasena del usuario demo@empresa.com en la base de datos
# de produccion. Si el usuario no existe, lo crea (admin de la empresa 1).
#
# Ejecutar desde Git Bash, en conta-app/backend:   bash scripts/cambiar-contrasena-demo.sh
#
# Usa las claves que dejo configurar-vercel-prod.sh en .env.vercel-prod.local
# (sin mostrarlas) y pide la contrasena nueva sin que se vea al escribirla.
set -euo pipefail

cd "$(dirname "$0")/.."

FICHERO=".env.vercel-prod.local"
[ -f "$FICHERO" ] || { echo "No existe $FICHERO: ejecuta antes scripts/configurar-vercel-prod.sh."; exit 1; }

valor() { grep -m1 "^$1=" "$FICHERO" | cut -d= -f2- || true; }

# Se exportan una a una (no se hace `source`): la URL lleva '&', que en un
# `source` mandaria parte de la linea a segundo plano.
export DATABASE_URL JWT_SECRET ENCRYPTION_KEY
DATABASE_URL="$(valor DATABASE_URL)"
JWT_SECRET="$(valor JWT_SECRET)"
ENCRYPTION_KEY="$(valor ENCRYPTION_KEY)"
for v in DATABASE_URL JWT_SECRET ENCRYPTION_KEY; do
  [ -n "${!v}" ] || { echo "Falta $v en $FICHERO. Abortado."; exit 1; }
done

echo "Contrasena para demo@empresa.com: minimo 12 caracteres."
echo "(En Git Bash se pega con Shift+Insert; no se vera lo que escribas.)"
read -rsp "Nueva contrasena: " P1; echo
read -rsp "Repitela: " P2; echo
[ "$P1" = "$P2" ] || { echo "No coinciden. Abortado."; exit 1; }
[ "${#P1}" -ge 12 ] || { echo "Tiene ${#P1} caracteres; hacen falta al menos 12. Abortado."; exit 1; }

export SEED_DEMO_PASSWORD="$P1"
unset P1 P2
NODE_ENV=production npx --yes tsx prisma/seed.ts
unset SEED_DEMO_PASSWORD

echo "LISTO: entra en https://conta-api-alpha.vercel.app con demo@empresa.com y la contrasena nueva."
