#!/usr/bin/env bash
# Aplica los arreglos de datos de prisma/arreglos/*.sql en la BD de PRODUCCION.
# Uso (Git Bash, desde la MISMA copia del backend con la que se aplico el
# esquema, despues de scripts/aplicar-esquema-prod.sh):
#   bash scripts/aplicar-arreglos-datos.sh
# Si el .env de produccion esta en otra carpeta:
#   ENV_PROD=../backend/.env.vercel-prod.local bash scripts/aplicar-arreglos-datos.sh
# Lee DATABASE_URL de .env.vercel-prod.local, como aplicar-esquema-prod.sh, y no
# la muestra. Cada .sql se puede ejecutar mas de una vez: los de un solo uso
# dejan una marca en AuditLog y en las pasadas siguientes no hacen nada.
set -euo pipefail
cd "$(dirname "$0")/.."

# Esta version necesita el esquema nuevo (Compras y permisos de usuarios, las
# mismas marcas que aplicar-esquema-prod.sh) y su arreglo de un solo uso, el de
# reabrir ejercicios. Sin ellos, esta copia es vieja (main de antes o una rama
# sin integrar): terminaria «LISTO» sin aplicar ese arreglo. Abortar.
for marca in 'model TipoCambioBce' 'numeroProveedorActivo' 'permisosPersonalizados' 'model AjustesFiscales'; do
  grep -q "$marca" prisma/schema.prisma || { echo "prisma/schema.prisma no tiene '$marca': usa la copia que se va a subir a main. Abortado."; exit 1; }
done
[ -f prisma/arreglos/2026-10-07-reabrir-ejercicios-cerrados-sin-asientos.sql ] || { echo "Falta prisma/arreglos/2026-10-07-reabrir-ejercicios-cerrados-sin-asientos.sql: esta copia no tiene los arreglos de esta version. Abortado."; exit 1; }

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
