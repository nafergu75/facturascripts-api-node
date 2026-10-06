#!/usr/bin/env bash
# Aplica a la base de datos de produccion (TiDB) los cambios de prisma/schema.prisma.
#
# Ejecutar desde Git Bash, en conta-app/backend:   bash scripts/aplicar-esquema-prod.sh
#
# Usa la DATABASE_URL que dejo configurar-vercel-prod.sh en .env.vercel-prod.local
# (sin mostrarla). NO acepta perdida de datos: si un cambio borrara columnas o
# datos, Prisma se para y no aplica nada.
set -euo pipefail

cd "$(dirname "$0")/.."

FICHERO=".env.vercel-prod.local"
[ -f "$FICHERO" ] || { echo "No existe $FICHERO: ejecuta antes scripts/configurar-vercel-prod.sh."; exit 1; }

DATABASE_URL="$(grep -m1 '^DATABASE_URL=' "$FICHERO" | cut -d= -f2- || true)"
[ -n "$DATABASE_URL" ] || { echo "Falta DATABASE_URL en $FICHERO. Abortado."; exit 1; }
export DATABASE_URL

echo "Aplicando el esquema a la base de datos de produccion..."
npx prisma db push --skip-generate
unset DATABASE_URL

echo "LISTO: esquema aplicado. Ya se puede subir el codigo que lo usa."
