#!/usr/bin/env bash
# Vacia la base de datos de PRODUCCION para entregar la app «a cero»: borra
# todas las empresas con todos sus datos y todos los usuarios que no son
# administradores globales, y los ficheros guardados de la app. Solo datos:
# el esquema no se toca.
#
# Lo lanza el usuario desde Git Bash, en la carpeta del backend con la version
# publicada y este script (a 14-10-2026: backend-ocrz, rama vaciar-produccion):
#   ENV_PROD=../backend/.env.vercel-prod.local bash scripts/vaciar-produccion.sh            (simula)
#   ENV_PROD=../backend/.env.vercel-prod.local bash scripts/vaciar-produccion.sh --borrar   (borra)
#   ENV_PROD=... bash scripts/vaciar-produccion.sh --comprobar
#   ENV_PROD=... bash scripts/vaciar-produccion.sh --restaurar <carpeta de la copia>
#   ENV_PROD=... bash scripts/vaciar-produccion.sh --restaurar-ficheros <carpeta de la copia>
#   bash scripts/vaciar-produccion.sh --ayuda
# Instrucciones completas: docs/vaciar-produccion.md.
#
# Lee DATABASE_URL (y BLOB_READ_WRITE_TOKEN si esta) de ENV_PROD sin
# mostrarlas. Variables opcionales: ENV_BLOB (otro fichero con la clave de
# Vercel Blob), COPIA_DIR (donde se guarda la copia; por defecto $HOME/Documents,
# que no es la carpeta Documentos de OneDrive).
# VACIADO_ALMACEN_DISCO es solo para las pruebas en local.
set -euo pipefail

cd "$(dirname "$0")/.."

# Esta carpeta, como la ve el usuario (C:/Users/...), y su rama.
CARPETA="$(pwd -W 2>/dev/null || pwd)"
RAMA="$(git branch --show-current 2>/dev/null || true)"
COMMIT="$(git rev-parse --short HEAD 2>/dev/null || true)"

# Ruta de Windows (con barras invertidas) para buscarla en el Explorador.
ruta_windows() { cygpath -w "$1" 2>/dev/null || printf '%s' "$1"; }

ayuda() {
  cat <<'TXT'
VACIAR PRODUCCIÓN: dejar la app a cero para entregarla

Borra TODAS las empresas con todos sus datos (facturas, gastos, cobros,
nóminas, lecturas, carga de 2026, auditoría...), todos los usuarios que no son
administradores globales y los ficheros guardados (facturas, PDF, lecturas).
Se conserva tu usuario de administrador global, con su contraseña.

TXT
  echo "Se lanza desde Git Bash, en ESTA carpeta (la del script):"
  echo "  cd \"$CARPETA\""
  echo "Ahora está en la rama ${RAMA:-?} (código $COMMIT). El 14-10-2026 el script estaba en la"
  echo "carpeta backend-ocrz, rama vaciar-produccion: el código publicado más este script. Si se"
  echo "ha publicado otra versión después, pide antes que se actualice esta rama; si no, el script"
  echo "se parará sin tocar nada."
  cat <<'TXT'

  0. Antes de nada: haz una copia de seguridad en TiDB Cloud (mira
     docs/vaciar-produccion.md) y cierra la app en el navegador.

  1. Simulación (no borra nada; enseña lo que borraría):
       ENV_PROD=../backend/.env.vercel-prod.local bash scripts/vaciar-produccion.sh

  2. Borrado de verdad:
       ENV_PROD=../backend/.env.vercel-prod.local bash scripts/vaciar-produccion.sh --borrar
     Repite la simulación, te pide qué administradores se quedan y que escribas
     BORRAR TODO. Hace una copia completa en C:\Users\<tu usuario>\Documents
     (conta-copia-...; no es la carpeta Documentos de OneDrive, así no se sube
     a la nube) y, solo si la copia sale bien, borra. Al final comprueba que
     todo ha quedado a cero y, si quieres, prueba a entrar con tu usuario.

  3. Comprobación (se puede repetir cuando quieras):
       ENV_PROD=../backend/.env.vercel-prod.local bash scripts/vaciar-produccion.sh --comprobar

  Si algo sale mal, restaura la copia local (base y ficheros):
       ENV_PROD=../backend/.env.vercel-prod.local bash scripts/vaciar-produccion.sh --restaurar "<carpeta de la copia>"
  Si en vez de eso restauras la base desde TiDB Cloud, esa copia no lleva los
  ficheros: súbelos después desde la copia local (no toca la base):
       ENV_PROD=../backend/.env.vercel-prod.local bash scripts/vaciar-produccion.sh --restaurar-ficheros "<carpeta de la copia>"

Para ver y borrar los ficheros hace falta la clave de Vercel Blob
(BLOB_READ_WRITE_TOKEN). Si no está en el fichero de ENV_PROD, el script la
pide (no se ve al pegarla). Sin ella, los ficheros se quedan como están.
TXT
}

MODO=simular
COPIA_RESTAURAR=""
case "${1:-}" in
  "") MODO=simular ;;
  --borrar) MODO=borrar ;;
  --comprobar) MODO=comprobar ;;
  --restaurar | --restaurar-ficheros)
    MODO="${1#--}"
    COPIA_RESTAURAR="${2:-}"
    [ -n "$COPIA_RESTAURAR" ] || { echo "Indica la carpeta de la copia: $1 <carpeta>"; exit 2; }
    [ -f "$COPIA_RESTAURAR/manifiesto.json" ] || { echo "En $COPIA_RESTAURAR no hay ninguna copia (falta manifiesto.json)."; exit 2; }
    ;;
  --ayuda | -h | --help) ayuda; exit 0 ;;
  *) echo "Opción desconocida: $1. Mira cómo se usa con: bash scripts/vaciar-produccion.sh --ayuda"; exit 2 ;;
esac

# 1) Esta copia del codigo tiene que ser la de la version publicada: las mismas
# MARCAS de esquema que comprueba scripts/aplicar-esquema-prod.sh (se leen de
# alli para que no se separen).
MARCAS=()
while IFS= read -r m; do MARCAS+=("$m"); done < <(
  sed -n '/^MARCAS=(/,/^)/p' scripts/aplicar-esquema-prod.sh | sed -n "s/^[[:space:]]*'\(.*\)'[[:space:]]*$/\1/p"
)
[ "${#MARCAS[@]}" -ge 40 ] || { echo "No he podido leer las MARCAS de scripts/aplicar-esquema-prod.sh. Abortado: no se ha tocado nada."; exit 3; }
for marca in "${MARCAS[@]}"; do
  grep -qF -- "$marca" prisma/schema.prisma || {
    echo "prisma/schema.prisma no tiene '$marca': esta copia del código no es la de la versión publicada."
    echo "Lánzalo desde la carpeta con la que aplicaste el esquema. Abortado: no se ha tocado nada."
    exit 3
  }
done

# 2) Base de datos de produccion (nunca se muestra).
FICHERO="${ENV_PROD:-.env.vercel-prod.local}"
[ -f "$FICHERO" ] || { echo "No existe $FICHERO: indica ENV_PROD=ruta del .env de producción."; exit 2; }
valor_de() { grep -m1 "^$1=" "$2" 2>/dev/null | cut -d= -f2- | tr -d '\r' | sed -e 's/^"//' -e 's/"$//' || true; }
DATABASE_URL="$(valor_de DATABASE_URL "$FICHERO")"
[ -n "$DATABASE_URL" ] || { echo "Falta DATABASE_URL en $FICHERO. Abortado."; exit 2; }
export DATABASE_URL

# 3) Clave de Vercel Blob para los ficheros (tampoco se muestra).
BLOB="${BLOB_READ_WRITE_TOKEN:-}"
[ -n "$BLOB" ] || BLOB="$(valor_de BLOB_READ_WRITE_TOKEN "$FICHERO")"
if [ -z "$BLOB" ] && [ -n "${ENV_BLOB:-}" ]; then BLOB="$(valor_de BLOB_READ_WRITE_TOKEN "$ENV_BLOB")"; fi
if [ -z "$BLOB" ] && [ -z "${VACIADO_ALMACEN_DISCO:-}" ]; then
  echo "Para ver y borrar los ficheros guardados (facturas, PDF, lecturas) hace falta la clave de Vercel Blob,"
  echo "BLOB_READ_WRITE_TOKEN (mira docs/vaciar-produccion.md para encontrarla)."
  read -rsp "Pégala y pulsa Intro (no se ve al pegarla), o pulsa Intro sin pegar nada para seguir sin los ficheros: " BLOB || true
  echo
  BLOB="$(printf '%s' "$BLOB" | tr -d '[:space:][:cntrl:]')"
  if [ -n "$BLOB" ] && [[ "$BLOB" != vercel_blob_rw_* ]]; then
    echo "Eso no parece una clave de Vercel Blob (empiezan por vercel_blob_rw_): sigo SIN los ficheros."
    BLOB=""
  fi
fi
unset BLOB_READ_WRITE_TOKEN
[ -z "$BLOB" ] || export BLOB_READ_WRITE_TOKEN="$BLOB"
unset BLOB

PLAN="$(mktemp)"
trap 'rm -f "$PLAN"; unset DATABASE_URL BLOB_READ_WRITE_TOKEN VACIADO_CLAVE' EXIT
export PRISMA_HIDE_UPDATE_MESSAGE=1
VACIADO_COMMIT="$(git rev-parse --short HEAD 2>/dev/null || true)"
export VACIADO_COMMIT

orden() { npx ts-node --transpile-only scripts/vaciar-produccion.ts "$@"; }

echo "Código: $CARPETA · rama ${RAMA:-?} ($COMMIT)"

ADMINS_ID=()
ADMINS_EMAIL=()
ADMINS_ACTIVO=()
leer_plan() {
  ADMINS_ID=(); ADMINS_EMAIL=(); ADMINS_ACTIVO=()
  while IFS='|' read -r tipo a b c; do
    if [ "$tipo" = "ADMIN" ]; then ADMINS_ID+=("$a"); ADMINS_EMAIL+=("$b"); ADMINS_ACTIVO+=("$c"); fi
  done < "$PLAN"
}

# Ctrl+C durante --restaurar: la base puede haber quedado a medias.
restauracion_interrumpida() {
  echo
  echo "RESTAURACIÓN INTERRUMPIDA. Si ya había empezado a meter filas, la base ha quedado a medias."
  echo "No uses la app así. Para salir:"
  echo "  1. Vacía lo que se ha llegado a meter (antes hará otra copia; esa no te hace falta):"
  echo "       ENV_PROD=$FICHERO bash scripts/vaciar-produccion.sh --borrar"
  echo "  2. Repite la restauración con la misma copia:"
  echo "       ENV_PROD=$FICHERO bash scripts/vaciar-produccion.sh --restaurar \"$COPIA_RESTAURAR\""
  exit 130
}

# Prueba a entrar con un administrador (opcional: hace falta su contrasena).
probar_acceso() {
  leer_plan
  [ "${#ADMINS_EMAIL[@]}" -gt 0 ] || return 0
  local email="${ADMINS_EMAIL[0]}" otro="" clave=""
  if [ "${#ADMINS_EMAIL[@]}" -gt 1 ]; then
    read -rp "¿Con qué correo pruebo a entrar? (Intro = $email): " otro || true
    otro="$(printf '%s' "$otro" | tr -d '[:space:]')"
    [ -z "$otro" ] || email="$otro"
  fi
  echo
  echo "Para comprobar que puedes entrar, escribe la contraseña de $email y pulsa Intro."
  read -rsp "No se ve al escribirla ni se guarda. Para saltarlo, pulsa Intro sin escribir nada: " clave || true
  echo
  if [ -z "$clave" ]; then
    echo "Prueba de acceso saltada. Hazla a mano: abre la app, entra con $email y mira que sale"
    echo "Administración y ninguna empresa."
    return 0
  fi
  local codigo=0
  VACIADO_EMAIL="$email" VACIADO_CLAVE="$clave" orden acceso || codigo=$?
  clave=""
  return $codigo
}

case "$MODO" in
  simular)
    CODIGO=0
    orden simular --plan "$PLAN" || CODIGO=$?
    echo
    if [ "$CODIGO" -eq 0 ]; then
      echo "SIMULACIÓN: no se ha borrado nada. Para borrar de verdad, repite con --borrar."
    else
      echo "No se ha borrado nada."
    fi
    exit "$CODIGO"
    ;;

  comprobar)
    CODIGO=0
    orden comprobar --plan "$PLAN" || CODIGO=$?
    # Con un error o una parada no se sigue; si solo no cuadra, se prueba igual el acceso.
    [ "$CODIGO" -eq 0 ] || [ "$CODIGO" -eq 4 ] || exit "$CODIGO"
    ACCESO=0
    probar_acceso || ACCESO=$?
    [ "$CODIGO" -ne 0 ] && exit "$CODIGO"
    exit "$ACCESO"
    ;;

  restaurar)
    echo "Vas a RESTAURAR en la base de PRODUCCIÓN la copia de:"
    echo "  $COPIA_RESTAURAR"
    echo "Solo funciona sobre la base vaciada (sin empresas). Lo que haya ahora de los administradores se queda."
    FRASE=""
    read -rp "Para seguir escribe RESTAURAR COPIA y pulsa Intro; cualquier otra cosa cancela: " FRASE || true
    FRASE="$(printf '%s' "$FRASE" | tr -d '\r' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
    [ "$FRASE" = "RESTAURAR COPIA" ] || { echo "Cancelado. No se ha cambiado nada."; exit 1; }
    # Si se corta con Ctrl+C a mitad, la base puede quedar a medias: se dice como salir.
    trap 'restauracion_interrumpida' INT
    CODIGO=0
    orden restaurar --copia "$COPIA_RESTAURAR" || CODIGO=$?
    trap - INT
    exit "$CODIGO"
    ;;

  restaurar-ficheros)
    echo "Vas a SUBIR al almacén de ficheros de PRODUCCIÓN los ficheros de la copia:"
    echo "  $COPIA_RESTAURAR"
    echo "No toca la base de datos ni los ficheros que ya están (se puede repetir). Sirve después de"
    echo "restaurar la base desde TiDB Cloud, que no lleva los ficheros."
    FRASE=""
    read -rp "Para seguir escribe SUBIR FICHEROS y pulsa Intro; cualquier otra cosa cancela: " FRASE || true
    FRASE="$(printf '%s' "$FRASE" | tr -d '\r' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
    [ "$FRASE" = "SUBIR FICHEROS" ] || { echo "Cancelado. No se ha subido nada."; exit 1; }
    CODIGO=0
    orden restaurar-ficheros --copia "$COPIA_RESTAURAR" || CODIGO=$?
    exit "$CODIGO"
    ;;
esac

# --borrar
CODIGO=0
orden simular --plan "$PLAN" || CODIGO=$?
if [ "$CODIGO" -ne 0 ]; then
  echo
  echo "No se sigue. No se ha borrado nada."
  exit "$CODIGO"
fi

leer_plan
echo
echo "Administradores globales (se conservan con su contraseña; se les quitan las empresas):"
for i in "${!ADMINS_ID[@]}"; do
  estado="activo"; [ "${ADMINS_ACTIVO[$i]}" = "si" ] || estado="DESACTIVADO"
  echo "  $((i + 1))) ${ADMINS_EMAIL[$i]} ($estado)"
done
ELEGIDOS=""
read -rp "Pulsa Intro para conservarlos todos, o escribe los números de los que se quedan (por ejemplo 1 o 1,2): " ELEGIDOS || true
ELEGIDOS="$(printf '%s' "$ELEGIDOS" | tr -d '[:space:]')"
CONSERVAR=()
if [ -z "$ELEGIDOS" ]; then
  CONSERVAR=("${ADMINS_ID[@]}")
else
  IFS=',' read -r -a NUMEROS <<< "$ELEGIDOS"
  for n in "${NUMEROS[@]}"; do
    if ! [[ "$n" =~ ^[0-9]+$ ]] || [ "$n" -lt 1 ] || [ "$n" -gt "${#ADMINS_ID[@]}" ]; then
      echo "«$n» no es ninguno de los números de la lista. Cancelado: no se ha borrado nada."
      exit 1
    fi
    CONSERVAR+=("${ADMINS_ID[$((n - 1))]}")
  done
fi
SE_QUEDAN=""
for i in "${!ADMINS_ID[@]}"; do
  for c in "${CONSERVAR[@]}"; do [ "$c" = "${ADMINS_ID[$i]}" ] && SE_QUEDAN="$SE_QUEDAN ${ADMINS_EMAIL[$i]}"; done
done
LISTA_CONSERVAR="$(IFS=','; printf '%s' "${CONSERVAR[*]}")"

DESTINO="${COPIA_DIR:-$HOME/Documents}"
COPIA="$DESTINO/conta-copia-$(date +%Y%m%d-%H%M)"
[ ! -e "$COPIA" ] || COPIA="$COPIA-$(date +%S)"

echo
echo "================================================================"
echo "ATENCIÓN: se va a BORRAR TODO lo que ha salido en la simulación,"
echo "en la base de datos de PRODUCCIÓN y en sus ficheros."
echo "Se quedan solo estos administradores:$SE_QUEDAN"
echo "Antes se hará una copia completa en:"
echo "  $(ruta_windows "$COPIA")"
echo "Si la copia falla, no se borra nada."
echo "================================================================"
FRASE=""
read -rp "Para borrar de verdad escribe BORRAR TODO (en mayúsculas) y pulsa Intro; cualquier otra cosa cancela: " FRASE || true
FRASE="$(printf '%s' "$FRASE" | tr -d '\r' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
if [ "$FRASE" != "BORRAR TODO" ]; then
  echo "Cancelado. No se ha borrado nada."
  exit 1
fi

CODIGO=0
orden borrar --conservar "$LISTA_CONSERVAR" --copia "$COPIA" --plan "$PLAN" || CODIGO=$?
if [ "$CODIGO" -ne 0 ] && [ "$CODIGO" -ne 4 ]; then
  exit "$CODIGO"
fi

ACCESO=0
probar_acceso || ACCESO=$?
echo
echo "Siguiente: cierra la sesión en la app y vuelve a entrar (la sesión abierta recuerda las empresas"
echo "borradas). Después da de alta las empresas reales en Administración."
[ "$CODIGO" -ne 0 ] && exit "$CODIGO"
exit "$ACCESO"
