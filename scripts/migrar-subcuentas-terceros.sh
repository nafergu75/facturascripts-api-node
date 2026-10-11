#!/usr/bin/env bash
# Pasa lo ya contabilizado en las cuentas genericas 430, 400 y 410 a la
# subcuenta propia de cada cliente y proveedor, en la BD de PRODUCCION.
#
# Uso (Git Bash, desde la MISMA copia del backend con la que se aplico el
# esquema, despues de scripts/aplicar-esquema-prod.sh):
#   ENV_PROD=../backend/.env.vercel-prod.local bash scripts/migrar-subcuentas-terceros.sh --todas
#   ENV_PROD=... bash scripts/migrar-subcuentas-terceros.sh --empresa <id> [--incluir-cerrados]
# Siempre SIMULA primero (ensena lo que haria sin escribir). Con --aplicar,
# despues de la simulacion pide "si" y solo entonces escribe. Se puede repetir:
# una segunda pasada no cambia nada.
#
# Lee DATABASE_URL de ENV_PROD (por defecto .env.vercel-prod.local) y no la
# muestra.
set -euo pipefail
cd "$(dirname "$0")/.."

for marca in 'subcuenta430' 'subcuenta410'; do
  grep -q "$marca" prisma/schema.prisma || { echo "prisma/schema.prisma no tiene '$marca': esta copia no tiene las subcuentas de terceros. Abortado."; exit 1; }
done

APLICAR=0
RESTO=()
for arg in "$@"; do
  if [ "$arg" = "--aplicar" ]; then APLICAR=1; else RESTO+=("$arg"); fi
done
[ ${#RESTO[@]} -gt 0 ] || { echo "Uso: bash scripts/migrar-subcuentas-terceros.sh (--empresa <id> ... | --todas) [--aplicar] [--incluir-cerrados]"; exit 1; }

FICHERO="${ENV_PROD:-.env.vercel-prod.local}"
[ -f "$FICHERO" ] || { echo "No existe $FICHERO: indica ENV_PROD=ruta del .env de produccion."; exit 1; }
DATABASE_URL="$(grep -m1 '^DATABASE_URL=' "$FICHERO" | cut -d= -f2- || true)"
[ -n "$DATABASE_URL" ] || { echo "Falta DATABASE_URL en $FICHERO. Abortado."; exit 1; }
export DATABASE_URL
trap 'unset DATABASE_URL' EXIT
export NODE_ENV=production
export PRISMA_HIDE_UPDATE_MESSAGE=1
# El script no firma sesiones ni cifra nada, pero la configuracion de la app
# exige estas dos variables para arrancar: valores de relleno solo para este proceso.
export JWT_SECRET="${JWT_SECRET:-solo-para-migrar-subcuentas}"
export ENCRYPTION_KEY="${ENCRYPTION_KEY:-0000000000000000000000000000000000000000000000000000000000000000}"

echo "SIMULACION (no escribe nada):"
npx ts-node --transpile-only scripts/migrar-subcuentas-terceros.ts "${RESTO[@]}"

[ "$APLICAR" = "1" ] || exit 0
read -r -p "Escribe si (o sí) y pulsa Intro para APLICAR estos cambios; cualquier otra cosa cancela: " RESPUESTA
RESPUESTA="$(printf '%s' "$RESPUESTA" | tr -d '[:space:]')"
case "$RESPUESTA" in
  s* | S*) ;;
  *) echo "Cancelado: no se ha cambiado nada."; exit 0 ;;
esac
npx ts-node --transpile-only scripts/migrar-subcuentas-terceros.ts "${RESTO[@]}" --aplicar
echo "LISTO."
