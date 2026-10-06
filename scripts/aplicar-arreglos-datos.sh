#!/usr/bin/env bash
# Aplica los arreglos de datos de prisma/arreglos/*.sql en la BD de PRODUCCION.
# Uso (Git Bash, desde la carpeta backend): bash scripts/aplicar-arreglos-datos.sh
# Lee DATABASE_URL de .env.vercel-prod.local, como aplicar-esquema-prod.sh, y no
# la muestra. Cada .sql se puede ejecutar mas de una vez.
set -euo pipefail
cd "$(dirname "$0")/.."
FICHERO=".env.vercel-prod.local"
[ -f "$FICHERO" ] || { echo "No existe $FICHERO: ejecuta antes scripts/configurar-vercel-prod.sh."; exit 1; }
DATABASE_URL="$(grep -m1 '^DATABASE_URL=' "$FICHERO" | cut -d= -f2- || true)"
[ -n "$DATABASE_URL" ] || { echo "Falta DATABASE_URL en $FICHERO. Abortado."; exit 1; }
export DATABASE_URL
for f in prisma/arreglos/*.sql; do
  echo "Aplicando $f ..."
  npx prisma db execute --file "$f" --schema prisma/schema.prisma
done
unset DATABASE_URL
echo "LISTO: arreglos de datos aplicados."
