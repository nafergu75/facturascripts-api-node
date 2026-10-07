#!/usr/bin/env bash
# Da (o quita) el MODO ADMINISTRADOR GLOBAL a un usuario en la base de datos de
# produccion. Un administrador global ve y gestiona todas las empresas, tiene
# todos los permisos y ve la pantalla "Administracion" del panel.
#
# Ejecutar DESPUES de desplegar en Vercel la version con el modo administrador
# (con el codigo anterior el permiso sale del token y no basta con recargar),
# desde Git Bash, en una copia del backend con el esquema nuevo:
#   bash scripts/hacer-admin-global.sh tu@email.com             (dar)
#   bash scripts/hacer-admin-global.sh tu@email.com --quitar    (quitar)
#
# Usa la DATABASE_URL que dejo configurar-vercel-prod.sh en .env.vercel-prod.local
# (sin mostrarla). Antes de cambiar nada ensena a quien afecta y pide
# confirmacion. Tabla y columnas segun prisma/schema.prisma: modelo User
# (tabla `User`, sin @@map), columnas email, isGlobalAdmin e isActive.
set -euo pipefail
export LC_ALL=C

cd "$(dirname "$0")/.."

uso() { echo "Uso: bash scripts/hacer-admin-global.sh <email> [--quitar]"; }

QUITAR=0
EMAIL=""
for arg in "$@"; do
  case "$arg" in
    --quitar) QUITAR=1 ;;
    -h | --help) uso; exit 0 ;;
    -*) echo "Opcion desconocida: $arg"; uso; exit 1 ;;
    *)
      [ -z "$EMAIL" ] || { echo "Indica un solo email."; uso; exit 1; }
      EMAIL="$arg"
      ;;
  esac
done
[ -n "$EMAIL" ] || { uso; exit 1; }

# Email estricto ANTES de usarlo: letras, numeros y . _ % + - antes de la @, y
# un dominio con punto. Sin comillas, espacios, barras ni punto y coma, asi que
# no puede romper la sentencia SQL de abajo.
EMAIL_RE='^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$'
if [[ ! "$EMAIL" =~ $EMAIL_RE ]] || [ "${#EMAIL}" -gt 191 ]; then
  echo "Ese email no tiene un formato valido. Abortado: no se ha cambiado nada."
  exit 1
fi

FICHERO="${ENV_PROD:-.env.vercel-prod.local}"
[ -f "$FICHERO" ] || { echo "No existe $FICHERO: ejecuta antes scripts/configurar-vercel-prod.sh."; exit 1; }

DATABASE_URL="$(grep -m1 '^DATABASE_URL=' "$FICHERO" | cut -d= -f2- || true)"
[ -n "$DATABASE_URL" ] || { echo "Falta DATABASE_URL en $FICHERO. Abortado."; exit 1; }
export DATABASE_URL
trap 'unset DATABASE_URL' EXIT

# Lee el usuario (solo lectura). El email llega por variable de entorno, nunca
# pegado dentro del codigo. Salida: EXISTE|email|activo|admin|empresas|adminsActivos
consultar() {
  EMAIL_OBJETIVO="$EMAIL" node - <<'JS'
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
(async () => {
  const u = await prisma.user.findUnique({
    where: { email: process.env.EMAIL_OBJETIVO },
    select: { email: true, isActive: true, isGlobalAdmin: true, _count: { select: { memberships: true } } },
  });
  const admins = await prisma.user.count({ where: { isGlobalAdmin: true, isActive: true } });
  const si = (b) => (b ? 'si' : 'no');
  console.log(u
    ? ['SI', u.email, si(u.isActive), si(u.isGlobalAdmin), u._count.memberships, admins].join('|')
    : ['NO', '', '', '', '', admins].join('|'));
})()
  .catch((e) => {
    console.error('No se pudo leer la base de datos: ' + String((e && e.message) || e).split('\n')[0]);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
JS
}

echo "Consultando la base de datos de PRODUCCION..."
LINEA="$(consultar)" || { echo "Abortado: no se ha cambiado nada."; exit 1; }
IFS='|' read -r EXISTE EMAIL_BD ACTIVO ES_ADMIN N_EMPRESAS N_ADMINS <<< "$LINEA"

if [ "$EXISTE" != "SI" ]; then
  echo "No hay ningun usuario con el email $EMAIL. Revisa el email. No se ha cambiado nada."
  exit 1
fi

echo
echo "Usuario afectado:"
echo "  Email:                $EMAIL_BD"
echo "  Activo:               $ACTIVO"
echo "  Administrador global: $ES_ADMIN"
echo "  Empresas con acceso:  $N_EMPRESAS"
echo "  Administradores globales activos ahora: $N_ADMINS"
echo

if [ "$QUITAR" = 1 ]; then
  [ "$ES_ADMIN" = "si" ] || { echo "No es administrador global: no hay nada que quitar."; exit 0; }
  if [ "$ACTIVO" = "si" ] && [ "$N_ADMINS" -le 1 ]; then
    echo "Es el unico administrador global activo. Nombra antes a otro para no dejar la plataforma sin administrador. Abortado."
    exit 1
  fi
  PREGUNTA="Quitar el modo administrador global a $EMAIL_BD? (s/N) "
  VALOR=0
else
  [ "$ES_ADMIN" = "no" ] || { echo "Ya es administrador global: no hay nada que cambiar."; exit 0; }
  [ "$ACTIVO" = "si" ] || echo "AVISO: este usuario esta DESACTIVADO; no podra entrar hasta que se reactive."
  PREGUNTA="Dar el modo administrador global (todas las empresas y todos los permisos) a $EMAIL_BD? (s/N) "
  VALOR=1
fi

read -rp "$PREGUNTA" RESPUESTA
case "$RESPUESTA" in
  s | S | si | SI | Si) ;;
  *) echo "Cancelado. No se ha cambiado nada."; exit 0 ;;
esac

printf "UPDATE \`User\` SET isGlobalAdmin = %d WHERE email = '%s';\n" "$VALOR" "$EMAIL" |
  npx prisma db execute --stdin --schema prisma/schema.prisma

LINEA="$(consultar)" || { echo "Cambio enviado, pero no se ha podido comprobar. Revisalo en el panel."; exit 1; }
IFS='|' read -r _ _ _ ES_ADMIN _ N_ADMINS <<< "$LINEA"
echo "Ahora $EMAIL_BD -> administrador global: $ES_ADMIN (administradores activos: $N_ADMINS)."

if [ "$VALOR" = 1 ]; then
  echo "LISTO. Si tiene la app abierta, basta con RECARGAR la pagina: el servidor mira el permiso"
  echo "en cada peticion. Despues vera 'Administracion' en el menu."
else
  echo "LISTO. Lo pierde al momento: la pantalla de Administracion y el acceso a las empresas"
  echo "de las que no es miembro. Sigue entrando en las suyas con el rol que tenga en cada una."
fi
