#!/usr/bin/env bash
# Configura el backend de produccion en Vercel (proyecto facturascripts-api-node).
#
# Ejecutar desde Git Bash, en la raiz del repo:   bash scripts/configurar-vercel-prod.sh
#
# Que hace:
#   1. Enlaza ESTA carpeta (la raiz) con el proyecto Vercel del backend. Ojo: la
#      subcarpeta facturascripts-api-node/ esta enlazada al FRONTEND; no usarla.
#   2. Genera JWT_SECRET y ENCRYPTION_KEY nuevas en .env.vercel-prod.local
#      (ignorado por git). Nunca se muestran por pantalla.
#   3. Pide la DATABASE_URL sin mostrarla y la guarda en el mismo fichero.
#   4. Sube las variables a Vercel, crea las tablas (prisma db push) y el usuario
#      demo con la contrasena que elijas.
#   5. Redespliega el ultimo despliegue (no sube esta carpeta: `vercel deploy`
#      desde aqui se llevaria los ~20 proyectos que conviven en ella).
#
# Se puede repetir: reutiliza las claves del fichero y sustituye las variables.
set -euo pipefail

cd "$(dirname "$0")/.."

SCOPE="nafergu75s-projects"
PROYECTO="facturascripts-api-node"
URL_BACKEND="https://facturascripts-api-node.vercel.app"
URL_FRONTEND="https://conta-api-alpha.vercel.app"
FICHERO=".env.vercel-prod.local"

for cmd in vercel openssl npx curl; do
  command -v "$cmd" >/dev/null || { echo "Falta el comando '$cmd'."; exit 1; }
done

# El fichero de secretos NUNCA debe poder entrar en git.
git check-ignore -q "$FICHERO" || { echo "ERROR: $FICHERO no esta ignorado por git. Abortado."; exit 1; }

echo "1/5 Enlazando esta carpeta con el proyecto Vercel '$PROYECTO'..."
vercel link --yes --project "$PROYECTO" --scope "$SCOPE" >/dev/null

valor() { grep -m1 "^$1=" "$FICHERO" 2>/dev/null | cut -d= -f2- || true; }

echo "2/5 Claves de la aplicacion..."
umask 077
if [ -z "$(valor JWT_SECRET)" ] || [ -z "$(valor ENCRYPTION_KEY)" ]; then
  {
    echo "JWT_SECRET=$(openssl rand -hex 32)"
    echo "ENCRYPTION_KEY=$(openssl rand -hex 32)"
  } >> "$FICHERO"
  echo "    Generadas en $FICHERO (no se muestran)."
else
  echo "    Reutilizando las de $FICHERO."
fi

echo "3/5 Base de datos..."
if [ -z "$(valor DATABASE_URL)" ]; then
  echo "    En Git Bash se pega con Shift+Insert o clic derecho > Paste (Ctrl+V NO pega)."
  read -rsp "    Pega la DATABASE_URL de TiDB (no se mostrara) y pulsa Enter: " URL_BD
  echo
  # Limpieza: caracteres de control (un Ctrl+V mete uno invisible), espacios,
  # comillas y un posible prefijo DATABASE_URL= copiado de un .env.
  URL_BD="$(printf '%s' "$URL_BD" | tr -d '[:cntrl:]' | sed -E 's/^[[:space:]]+|[[:space:]]+$//g; s/^DATABASE_URL=//; s/^["'\'']//; s/["'\'']$//')"
  if [[ "$URL_BD" != mysql://* ]]; then
    # No se muestra lo pegado: podria contener la contrasena.
    echo "    Lo pegado no empieza por mysql:// (${#URL_BD} caracteres). Abortado."
    echo "    Vuelve a lanzar el script y pega SOLO la URL, sin comillas."
    exit 1
  fi
  [[ "$URL_BD" == *sslaccept=strict* ]] || { echo "    La URL debe llevar sslaccept=strict (TLS obligatorio en TiDB). Abortado."; exit 1; }
  # En serverless cada funcion abre su pool: una conexion por funcion.
  [[ "$URL_BD" == *connection_limit=* ]] || URL_BD="${URL_BD}&connection_limit=1"
  echo "DATABASE_URL=$URL_BD" >> "$FICHERO"
  unset URL_BD
  echo "    DATABASE_URL guardada (no se muestra)."
fi

echo "4/5 Subiendo variables a Vercel..."
# El valor va por stdin (no aparece en la lista de procesos). --force sustituye
# la variable si ya existe; los secretos se marcan sensitive (no se pueden leer
# despues desde Vercel, solo sustituir).
subir() {
  local nombre="$1" valor_var="$2" tipo="$3"
  printf '%s' "$valor_var" | vercel env add "$nombre" production "$tipo" --force --scope "$SCOPE" >/dev/null
  echo "    $nombre configurada"
}
subir JWT_SECRET "$(valor JWT_SECRET)" --sensitive
subir ENCRYPTION_KEY "$(valor ENCRYPTION_KEY)" --sensitive
subir DATABASE_URL "$(valor DATABASE_URL)" --sensitive
subir CORS_ORIGIN "$URL_FRONTEND" --no-sensitive

export JWT_SECRET ENCRYPTION_KEY DATABASE_URL
JWT_SECRET="$(valor JWT_SECRET)"
ENCRYPTION_KEY="$(valor ENCRYPTION_KEY)"
DATABASE_URL="$(valor DATABASE_URL)"

echo "    Creando tablas (prisma db push)..."
npx prisma db push --skip-generate

echo "    Usuario demo@empresa.com (admin de la empresa 1)."
read -rsp "    Elige su contrasena (minimo 12 caracteres, no se mostrara): " SEED_DEMO_PASSWORD
echo
export SEED_DEMO_PASSWORD
NODE_ENV=production npx --yes tsx prisma/seed.ts
unset SEED_DEMO_PASSWORD

echo "5/5 Redesplegando para que las variables surtan efecto..."
vercel redeploy "$URL_BACKEND" --target production --scope "$SCOPE" >/dev/null

echo "    Esperando a que responda $URL_BACKEND/health ..."
for _ in $(seq 1 30); do
  codigo=$(curl -s -o /dev/null -w '%{http_code}' -m 20 "$URL_BACKEND/health" || true)
  if [ "$codigo" = "200" ]; then
    echo "LISTO: el backend responde 200."
    exit 0
  fi
  sleep 10
done
echo "El backend aun no responde 200 (ultimo codigo: $codigo). Revisa los logs en Vercel."
exit 1
