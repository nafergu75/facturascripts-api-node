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
# confirmacion. NO acepta perdida de datos: si el cambio borra, renombra o
# modifica algo, se para. Lo que aplica es exactamente el SQL que ha ensenado
# (prisma db execute). Antes se usaba prisma db push, que se paraba con un
# aviso de «data loss» por cualquier indice UNICO nuevo en una tabla con filas
# (esta version anade uno en ExpenseInvoice) y entonces no aplicaba nada.
set -euo pipefail

cd "$(dirname "$0")/.."

# Lo minimo que tiene que traer el esquema de esta version (divisas, nominas,
# modo administrador, Carmen, Configuracion y Compras). Si falta, esta copia
# tiene un esquema viejo: aplicarlo no haria nada y el codigo nuevo fallaria en
# produccion por tablas o columnas que no existen (con Carmen: CarmenContador,
# CarmenLlamadaIA, CarmenAjustes y las columnas nuevas de ChatSession y
# ChatMessage; con Configuracion: AjustesFacturacion, AjustesFiscales y las
# copias ibanCobro y textoPie de la factura emitida; con Compras: el numero de
# factura del proveedor, numeroProveedorActivo y numeroFacturaEmisor; con los
# permisos de usuarios: la contraseña provisional y los permisos a medida).
# Una marca por linea: al integrar otra rama que añada las suyas, se añaden
# lineas y no choca con esta lista.
MARCAS=(
  'model TipoCambioBce'
  'model Nomina '
  'model LiquidacionSS'
  'monedaCuenta'
  'model CarmenContador'
  'model CarmenLlamadaIA'
  'model CarmenAjustes'
  'permisoRequerido'
  'model AjustesFacturacion'
  'model AjustesFiscales'
  'ibanCobro'
  'numeroProveedorActivo'
  'numeroFacturaEmisor'
  'debeCambiarContrasena'
  'contrasenaProvisionalHasta'
  'permisosPersonalizados'
  'subcuenta430'
  'subcuenta400'
  'subcuenta410'
  'model LecturaDocumento'
  'model VerifactuConfig'
  'model AjustePlataforma'
  'pantalla | api | copia | lector'
  'model InmuebleArrendado'
  'inmuebleArrendadoId'
  'clave349 '
  'personaContacto'
  'model DeclaracionAeat'
  'claveActividad'
  'epigrafeIae'
  'inicioEnApp'
  'model AjustesFiscalesVigencia'
  'model ExpenseInvoiceRectificada'
  'model CompensacionGasto'
  'fechaImputacionIva'
  'compensarFuera'
  'llevanza'
  'fechaSaldoInicial'
  'model CargaArranque'
  'model PartidaPendiente'
  'model ActivoFijo'
  'model DotacionAmortizacion'
  'rectificaFueraNumero'
  'Nombre y apellidos del usuario'
  'Telefono de contacto del usuario'
  'model IncomeInvoiceRectificada'
  'Causa de la rectificativa de venta'
  'unidadesPorPack'
  'kgPlasticoUnidad'
  'llevaIeepnr'
  'textoFactura'
  'ieepnrImporte'
  'textoAdicional'
  'pesoBrutoKg'
  'ieepnrRepercute'
  'ieepnrCuenta'
  'Plantilla del PDF de la serie'
  'Packs de la linea'
  'Cuenta del IEEPNR congelada al emitir'
  'Obra de la factura (plantilla B)'
  'Peso neto en kg escrito a mano (plantilla B)'
  'Observaciones por defecto de la serie'
  'Palets de la linea (plantilla B)'
  'Metros cuadrados de la linea (plantilla B)'
  'Unidad del precio (plantilla B)'
  'Cargo de palets de madera (plantilla B)'
  'Metros cuadrados por caja (plantilla B)'
  'Kg por unidad del precio'
  'Cuenta de ingresos del cargo de palets'
  'model ImagenFactura'
  'La empresa vende ceramica'
  'Web del proveedor'
  'Web del cliente'
  'model VerifactuCadena'
  'model VerifactuRegistro'
  'model VerifactuLote'
  'model VerifactuCertificado'
  'model VerifactuBitacora'
  'nifObligado'
  'numeroInstalacion'
  'declaracionVersion'
  'anuladaPor'
  'descripcionOperacion'
  'instantaneaEmision'
  'verifactuEstado'
  'pruebasVerifactuDe'
  'nifRepresentante'
  'tipoCertificado'
  'actuaComo'
  'pruebaConexionFecha'
  'pruebaConexionEntorno'
  'pruebaConexionOk'
  'pruebaConexionTipo'
  'pruebaConexionMensaje'
)
for marca in "${MARCAS[@]}"; do
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
# Sin el aviso de "Update available" de Prisma: nada que no sea SQL en la vista previa.
export PRISMA_HIDE_UPDATE_MESSAGE=1

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

# 2) Aplicar exactamente el SQL que se ha ensenado y revisado.
echo "Aplicando el esquema a la base de datos de produccion..."
npx prisma db execute --file "$PREVIA" --schema prisma/schema.prisma

# 3) Comprobarlo: la base ya tiene que coincidir con el esquema de esta copia.
npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --script > "$PREVIA"
if grep -qiE '^[[:space:]]*(CREATE|ALTER|DROP|RENAME)' "$PREVIA"; then
  echo "ATENCION: despues de aplicarlo, todavia quedan cambios pendientes:"
  cat "$PREVIA"
  echo "No subas el backend todavia: revisalo antes."
  exit 1
fi

echo "LISTO: esquema aplicado y comprobado. Siguiente paso: scripts/aplicar-arreglos-datos.sh desde esta misma copia."
