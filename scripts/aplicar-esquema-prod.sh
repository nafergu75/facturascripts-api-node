#!/usr/bin/env bash
# Aplica a la base de datos de produccion (TiDB) los cambios de prisma/schema.prisma.
#
# Ejecutar desde Git Bash, en una copia del backend con el esquema NUEVO (la
# rama que se va a subir a main, p. ej. conta-app/backend-pub, o
# conta-app/backend despues de fusionar y hacer checkout de main):
#   bash scripts/aplicar-esquema-prod.sh
# Si el .env de produccion esta en otra carpeta:
#   ENV_PROD=../backend/.env.vercel-prod.local bash scripts/aplicar-esquema-prod.sh
#
# Usa la DATABASE_URL que dejo configurar-vercel-prod.sh en .env.vercel-prod.local
# (sin mostrarla). Antes de aplicar nada ensena el SQL que va a ejecutar y pide
# confirmacion. NO acepta perdida de datos: si el cambio borra o modifica
# columnas, se para; y si algo borrara datos, Prisma tampoco lo aplica.
set -euo pipefail

cd "$(dirname "$0")/.."

# Lo minimo que tiene que traer el esquema de esta version (divisas, nominas,
# modo administrador y Carmen). Si falta, esta copia tiene un esquema viejo:
# aplicarlo no haria nada y el codigo nuevo fallaria en produccion por tablas o
# columnas que no existen (con Carmen: CarmenContador, CarmenLlamadaIA,
# CarmenAjustes y las columnas nuevas de ChatSession y ChatMessage).
for marca in 'model TipoCambioBce' 'model Nomina ' 'model LiquidacionSS' 'monedaCuenta'   'model CarmenContador' 'model CarmenLlamadaIA' 'model CarmenAjustes' 'permisoRequerido'; do
  grep -q "$marca" prisma/schema.prisma || {
    echo "prisma/schema.prisma no tiene '$marca': esta copia no tiene el esquema nuevo."
    echo "Ejecutalo desde la copia que se va a subir a main. Abortado."
    exit 1
  }
done

FICHERO="${ENV_PROD:-.env.vercel-prod.local}"
[ -f "$FICHERO" ] || { echo "No existe $FICHERO: ejecuta antes scripts/configurar-vercel-prod.sh (o indica ENV_PROD=ruta)."; exit 1; }

DATABASE_URL="$(grep -m1 '^DATABASE_URL=' "$FICHERO" | cut -d= -f2- || true)"
[ -n "$DATABASE_URL" ] || { echo "Falta DATABASE_URL en $FICHERO. Abortado."; exit 1; }
export DATABASE_URL

# 1) Vista previa, solo lectura: el SQL que llevaria la BD al esquema de esta copia.
PREVIA="$(mktemp)"
trap 'rm -f "$PREVIA"; unset DATABASE_URL' EXIT
npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --script > "$PREVIA"

if ! grep -qiE '^[[:space:]]*(CREATE|ALTER|DROP|RENAME)' "$PREVIA"; then
  echo "La base de datos ya tiene este esquema: no hay nada que aplicar."
  exit 0
fi

echo "Cambios que se aplicarian en PRODUCCION:"
echo "----------------------------------------"
cat "$PREVIA"
echo "----------------------------------------"

if grep -qiE '\b(DROP|MODIFY|CHANGE|RENAME)\b' "$PREVIA"; then
  echo "El cambio borra, renombra o modifica algo (DROP/MODIFY/CHANGE/RENAME). No se aplica."
  echo "Revisalo antes con calma: esta version solo deberia ANADIR columnas, tablas e indices. Abortado."
  exit 1
fi

read -r -p "Escribe si (o sí) y pulsa Intro para aplicarlo; cualquier otra cosa cancela: " RESPUESTA
# Vale si, SI, sí, Sí... (empieza por s); se quitan espacios y el retorno de carro.
RESPUESTA="$(printf '%s' "$RESPUESTA" | tr -d '[:space:]')"
case "$RESPUESTA" in
  [sS]*) ;;
  *) echo "Cancelado. No se ha cambiado nada."; exit 1 ;;
esac

# 2) Aplicarlo.
echo "Aplicando el esquema a la base de datos de produccion..."
npx prisma db push --skip-generate

echo "LISTO: esquema aplicado. Siguiente paso: scripts/aplicar-arreglos-datos.sh desde esta misma copia."
