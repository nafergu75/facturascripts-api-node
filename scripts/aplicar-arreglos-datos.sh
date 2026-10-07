#!/usr/bin/env bash
# Aplica los arreglos de datos de prisma/arreglos/*.sql en la BD de PRODUCCION.
# Uso (Git Bash, desde la MISMA copia del backend con la que se aplico el
# esquema, despues de scripts/aplicar-esquema-prod.sh):
#   bash scripts/aplicar-arreglos-datos.sh
# Si el .env de produccion esta en otra carpeta:
#   ENV_PROD=../backend/.env.vercel-prod.local bash scripts/aplicar-arreglos-datos.sh
# Lee DATABASE_URL de .env.vercel-prod.local, como aplicar-esquema-prod.sh, y no
# la muestra. Cada .sql se puede ejecutar mas de una vez.
set -euo pipefail
cd "$(dirname "$0")/.."

# Esta version necesita el esquema nuevo y el arreglo del pais de los clientes
# de las facturas anteriores. Sin ellos, esta copia es vieja: abortar.
grep -q 'model TipoCambioBce' prisma/schema.prisma || { echo "prisma/schema.prisma no tiene el esquema nuevo: usa la copia que se va a subir a main. Abortado."; exit 1; }
ls prisma/arreglos/2026-10-08-*.sql > /dev/null 2>&1 || { echo "Falta prisma/arreglos/2026-10-08-*.sql: esta copia no tiene los arreglos de esta version. Abortado."; exit 1; }

FICHERO="${ENV_PROD:-.env.vercel-prod.local}"
[ -f "$FICHERO" ] || { echo "No existe $FICHERO: ejecuta antes scripts/configurar-vercel-prod.sh (o indica ENV_PROD=ruta)."; exit 1; }
DATABASE_URL="$(grep -m1 '^DATABASE_URL=' "$FICHERO" | cut -d= -f2- || true)"
[ -n "$DATABASE_URL" ] || { echo "Falta DATABASE_URL en $FICHERO. Abortado."; exit 1; }
export DATABASE_URL
for f in prisma/arreglos/*.sql; do
  echo "Aplicando $f ..."
  npx prisma db execute --file "$f" --schema prisma/schema.prisma
done
unset DATABASE_URL
echo "LISTO: arreglos de datos aplicados."
