# Vaciar producción para entregar la app a cero

Cuando termines tus pruebas, este script deja la app de producción sin datos para entregarla:

- borra **todas las empresas** con todo lo suyo: facturas, gastos, rectificativas, cobros y pagos, asientos, nóminas, lecturas, la carga de 2026, declaraciones, Carmen, auditoría...;
- borra **todos los usuarios que no son administradores globales**;
- borra los **ficheros guardados** de la app en Vercel Blob: facturas subidas, PDF, lecturas, ficheros de la gestoría...

Se queda **tu usuario de administrador global**, con su contraseña de siempre, sin ninguna empresa. Las empresas reales (IFBIOSOLUCIONES, NEWZELAND) se dan de alta otra vez al entregar.

Solo borra datos. El esquema (las tablas y sus columnas) no se toca.

El script lo lanzas tú desde Git Bash, igual que `aplicar-esquema-prod.sh`. Lee la base de datos del fichero de producción y no la enseña nunca.

## Antes de empezar

- **Desde qué carpeta.** Tiene que tener a la vez la versión publicada y este script.
  - Desde que se publique `integracion-6` (que ya lleva este script, VERI*FACTU F1 y las plantillas A y B, con su esquema): `backend-pub`, en la rama publicada.
  - Mientras producción siga sin el esquema de `integracion-6` (el 14-10-2026, `41e6134`): `backend-ocrz`, en la rama `vaciar-produccion` (el esquema de `a6ace96`, que es el mismo).
  - Para comprobarlo, en Git Bash: `cd` a esa carpeta y después `git branch --show-current`.
  - Si después se publica otra versión, pide antes que se actualice.
  - `bash scripts/vaciar-produccion.sh --ayuda` también te dice la carpeta y la rama.
  - Si la base no tiene exactamente el esquema del código de la carpeta (le falta o le sobra una tabla o una columna), el script se para sin tocar nada.
- Cierra la app en el navegador y no la uses mientras dura. Si algo cambia mientras se hace la copia, el script se para sin borrar.
- Ten a mano la clave de Vercel Blob (más abajo explico dónde está). Sin ella se borra la base, pero los ficheros se quedan en Vercel Blob.
- Comprueba que tienes sitio en el disco para la copia: ocupa más o menos lo mismo que los datos y los ficheros.

## Paso 1. Copia de seguridad en TiDB Cloud

Además de la copia que hace el script en tu ordenador, ten una en TiDB Cloud:

1. Entra en TiDB Cloud y abre el clúster de producción (base `conta`).
2. Busca el apartado de copias de seguridad (**Backup**). TiDB hace una copia automática cada día: apunta la fecha y la hora de la última.
3. Si te deja hacer una copia manual en ese momento, hazla y espera a que termine.
4. Si tu plan permite exportar los datos (apartado **Import/Export**), puedes descargar también un fichero con todo.

Los nombres de los menús de TiDB Cloud pueden cambiar. Si no encuentras el apartado, busca «Backup & Restore» en su ayuda. No he podido comprobar qué opciones tiene tu plan.

## Paso 2. Simulación (no borra nada)

```bash
cd "/c/Users/NACHO PC/Desktop/conta-app/backend-pub"
ENV_PROD=../backend/.env.vercel-prod.local bash scripts/vaciar-produccion.sh
```

(o `backend-ocrz` si todavía no se ha publicado `integracion-6`; ver «Desde qué carpeta»).

`ENV_PROD` es el mismo fichero que usas con `aplicar-esquema-prod.sh`. La ruta es relativa a la carpeta desde la que lo lanzas.

Si no encuentra la clave de Vercel Blob, te la pide. Pégala con clic derecho > Paste o con Mayúsculas+Insert (Ctrl+V no pega en Git Bash). No se ve al pegarla. Si pulsas Intro sin pegar nada, sigue sin los ficheros.

Te enseña:

- **Usuarios**: cuáles se conservan (los administradores globales) y cuáles se borran.
- **Empresas**: cada una con su NIF, su id y cuántas filas tiene en cada tabla.
- **Tablas que se vacían**, con las filas que se borrarían de cada una.
- **Tablas que se vacían en parte** y **las que se conservan**, con el porqué.
- **Ficheros**: cuántos hay en cada carpeta, cuánto ocupan y de qué empresa son. Los que no son de la app no se tocan.
- **Avisos**: por ejemplo, declaraciones marcadas como presentadas a la AEAT o la red de seguridad de VERI*FACTU desactivada.
- Un **resumen** con el total.

Si algo no cuadra, sale el apartado «NO SE PUEDE SEGUIR» y no hay forma de borrar hasta arreglarlo.

## Paso 3. Borrado

```bash
ENV_PROD=../backend/.env.vercel-prod.local bash scripts/vaciar-produccion.sh --borrar
```

Por orden:

1. Repite la simulación.
2. Te enseña los administradores globales. Pulsa Intro para conservarlos todos, o escribe los números de los que se quedan (por ejemplo `1`).
3. Te dice dónde va a dejar la copia: `C:\Users\NACHO PC\Documents\conta-copia-AAAAMMDD-HHMM`. Ojo: no es la carpeta «Documentos» que sale en el Explorador, que en este equipo está dentro de OneDrive. Así la copia no se sube a la nube. Para abrirla, pega esa ruta en la barra del Explorador.
4. Te pide que escribas **`BORRAR TODO`**, en mayúsculas. Cualquier otra cosa cancela sin tocar nada.
5. **Copia local completa**: todas las filas de todas las tablas y todos los ficheros de la app. La comprueba al terminar. Si falla, no borra nada.
6. Comprueba que nada ha cambiado desde la copia. Si algo ha cambiado, no borra.
7. **Borra** tabla a tabla, en lotes pequeños, y después los ficheros.
8. **Comprobación final**: el recuento de cada tabla (0 en las que se vacían) y tus datos de administrador.
9. Si quieres, **prueba a entrar** con tu usuario: escribe tu contraseña (no se ve ni se guarda) o pulsa Intro para saltarlo.

Al acabar, cierra la sesión en la app y vuelve a entrar: la sesión abierta todavía recuerda las empresas borradas. Después da de alta las empresas reales en Administración.

Guarda la carpeta de la copia en un sitio seguro: tiene datos personales y fiscales. El script no deja hacerla dentro de una carpeta con git, para que nunca acabe subida. Para guardarla en otro sitio, pon delante `COPIA_DIR=/ruta/de/la/carpeta`.

## Paso 4. Comprobación (cuando quieras)

```bash
ENV_PROD=../backend/.env.vercel-prod.local bash scripts/vaciar-produccion.sh --comprobar
```

Comprueba que no queda ninguna empresa ni dato de ninguna empresa, que solo quedan administradores globales (y alguno activo) y que no hay filas sueltas de usuarios borrados. Si tienes la clave de Vercel Blob, mira también que no quedan ficheros de la app. Al final te ofrece probar a entrar.

Tiene sentido justo después del borrado. Cuando des de alta empresas, dirá que no cuadra, y es normal.

Para comprobarlo a mano: entra en la app con tu usuario. Tiene que salir Administración y ninguna empresa. Da de alta una empresa y emite su primera factura: será la **A-1**. La primera rectificativa será la **R-1** y la primera proforma la **P-1**.

## Si algo sale mal

- **Si el script se para antes de borrar**: no ha cambiado nada. Lee el mensaje, arregla lo que diga y vuelve a lanzarlo.
- **Si el borrado se corta a medias** (por ejemplo, se va la conexión): vuelve a lanzar `--borrar`. Sigue con lo que queda y antes copia lo que quede en otra carpeta. Si después quieres volver atrás, la copia buena es la primera, la de antes de empezar (la más antigua de las `conta-copia-...`). La marca `VACIADO_PRODUCCION` que queda en la auditoría apunta a la última copia, la del segundo intento: no te fíes de ella para esto.
- **Si la comprobación final no cuadra**: no hagas nada más en la app. Lanza `--comprobar` otra vez y mira qué tabla falla.
- **Para volver atrás**, tienes dos copias:
  1. **La local** (`C:\Users\NACHO PC\Documents\conta-copia-...`). Es la única que trae la base **y** los ficheros. Solo se puede meter sobre la base vaciada, antes de dar de alta ninguna empresa:

     ```bash
     ENV_PROD=../backend/.env.vercel-prod.local bash scripts/vaciar-produccion.sh --restaurar "/c/Users/NACHO PC/Documents/conta-copia-AAAAMMDD-HHMM"
     ```

     Te pide que escribas `RESTAURAR COPIA`. Antes de meter nada comprueba la copia entera (tablas, columnas y ficheros). Después vuelve a meter todas las filas y sube los ficheros a Vercel Blob (con la clave), en la misma dirección que tenían.
  2. **La de TiDB Cloud** (paso 1). Es la red de seguridad si la local falla. Se restaura desde el apartado Backup de TiDB Cloud. Ojo: si restauras «en el mismo clúster», se pierde todo lo que hayas hecho después de esa copia.
     - **Esa copia solo tiene la base, no los ficheros**: cuando la restaures, los ficheros ya se habrán borrado de Vercel Blob y las facturas, lecturas y PDF apuntarán a ficheros que no existen. Súbelos desde la copia local, sin tocar la base:

       ```bash
       ENV_PROD=../backend/.env.vercel-prod.local bash scripts/vaciar-produccion.sh --restaurar-ficheros "/c/Users/NACHO PC/Documents/conta-copia-AAAAMMDD-HHMM"
       ```

       Te pide que escribas `SUBIR FICHEROS`. Los sube con la misma dirección que tenían y no toca los que ya estén, así que se puede repetir.
- **Si la restauración local se corta a medias** (se va la conexión, pulsas Ctrl+C...): la base se queda con una parte de la copia, y `--restaurar` ya no deja repetirla porque la base no está vacía. El script te dice qué hacer:
  1. Vacía lo que se ha llegado a meter con `--borrar` (escribe `BORRAR TODO`). Antes hará otra copia de lo que haya; esa no te hace falta.
  2. Repite `--restaurar` con **la misma copia** de antes. La copia no cambia al restaurarla.

  Si se corta al subir los ficheros (las filas ya están todas), basta con `--restaurar-ficheros` con la misma copia.

## La clave de Vercel Blob

Los ficheros de la app están en Vercel Blob privado. Para verlos, copiarlos y borrarlos, el script necesita la clave `BLOB_READ_WRITE_TOKEN` (empieza por `vercel_blob_rw_`).

Dónde está: en Vercel, proyecto `facturascripts-api-node`, pestaña **Storage**, en el almacén Blob conectado. Allí aparece la variable `BLOB_READ_WRITE_TOKEN` para copiarla (a veces dentro de un apartado tipo «.env.local» o «Quickstart»). También está en **Settings > Environment Variables** del proyecto, si deja ver su valor.

Puedes:

- pegarla cuando el script la pida;
- añadir una línea `BLOB_READ_WRITE_TOKEN=...` al fichero `.env.vercel-prod.local`;
- o guardarla en otro fichero e indicarlo con `ENV_BLOB=ruta`.

Si borras sin la clave, los ficheros se quedan en Vercel Blob. Nadie los puede ver desde la app, pero ocupan sitio. Para borrarlos después, repite `--borrar` con la clave: la base ya está vacía y solo borrará los ficheros (antes hace su copia).

## Qué se hace con cada tabla

Las tablas salen del esquema de Prisma, no de una lista escrita a mano: si mañana se añade una tabla con `companyId`, o una que cuelga de otra que lo tiene, se vacía sola. Si se añade una tabla común que no es de ninguna empresa, el script se para hasta que alguien decida qué hacer con ella (`src/services/vaciadoProduccion/tablas.ts`, `REGLAS`).

**Se vacían enteras (71 tablas):**

- todas las que tienen `companyId`: facturas de venta y gasto con sus rectificativas, cobros y pagos, series, asientos y apuntes, libros de IVA y retenciones, modelos y declaraciones de la AEAT, nóminas y trabajadores, lecturas, carga de 2026 con sus partidas, activos y dotaciones, bancos y tesorería, plan de periodos y ejercicios, ajustes de cada empresa, membresías, Carmen, el logo de la marca y el sello de la plantilla B (`ImagenFactura`)...;
- VERI*FACTU de cada empresa: su configuración, la cadena (`VerifactuCadena`), los registros de las facturas (`VerifactuRegistro`), los envíos (`VerifactuLote`) y el certificado (`VerifactuCertificado`). Los registros son del entorno de pruebas de la AEAT. La app no deja cambiarlos ni borrarlos, así que el script los borra con SQL, antes que sus facturas. Al dar de alta de nuevo una empresa hay que volver a subir su certificado. Las empresas de pruebas de VERI*FACTU («… (PRUEBAS)») se borran igual que las demás. La copia local en JSON lleva el certificado y su contraseña tal como están en la base, cifrados y ligados a cada empresa: sin la `ENCRYPTION_KEY` de producción no sirven, pero guarda esa copia con el mismo cuidado que el certificado;
- las que cuelgan de una de ellas sin tener `companyId`: líneas de las facturas, partes de los movimientos bancarios, contactos, cuentas e historial de los proveedores;
- `Company`: las empresas.

**Se vacían en parte:**

| Tabla | Qué se queda |
|---|---|
| `User` | Los administradores globales que confirmes, con su contraseña. El resto se borra. |
| `RevokedToken` | Las sesiones cerradas del administrador, para que una sesión suya ya cerrada siga sin valer. |
| `CarmenContador` | El gasto de la IA del mes en toda la plataforma (`global:`), así el tope de 5 € sigue contando bien, y los contadores del administrador. |
| `ChartOfAccounts` | Las cuentas del plan base común (sin empresa), si las hay. Las de las empresas se borran. |
| `AuditLog` | Los cambios de los ajustes de la plataforma que hizo el administrador. Al terminar se añade una fila `VACIADO_PRODUCCION` con el resumen y la carpeta de la copia. |
| `VerifactuBitacora` | Los sucesos de VERI*FACTU de toda la plataforma (sin empresa) que no tienen usuario o que hizo el administrador. Los de las empresas y los de los usuarios que se borran, fuera. |

**Se conservan enteras:**

| Tabla | Por qué |
|---|---|
| `ChartOfAccountsVersion` | Es la versión del PGC, común a todas las empresas. El plan de cuentas de cada empresa nueva apunta a ella. |
| `TipoCambioBce` | Tipos de cambio publicados por el BCE: datos públicos, no son de ninguna empresa. |
| `AjustePlataforma` | Ajustes de toda la plataforma, como la red de seguridad de VERI*FACTU. Los decide el administrador global. |

Ninguna de estas tres es imprescindible para arrancar: la app crea la versión del PGC y los tipos de cambio cuando le hacen falta, y sin ajustes la red de seguridad está activa. Se conservan porque no son datos de prueba de ninguna empresa.

Los **logos** de las empresas no están en Vercel Blob: van dentro de la base (`LegalConfig.logo`) y se borran con ella. Lo mismo el logo de la marca y el sello de la plantilla B (`ImagenFactura`): la simulación dice cuántos hay.

## Cómo está hecho (para quien lo revise)

- **Seguridad de la conexión.** Hay dos comprobaciones distintas:
  - **El código.** En la carpeta tienen que estar las `MARCAS` de `aplicar-esquema-prod.sh` (se leen de ese fichero y se buscan en su `prisma/schema.prisma`). Esto solo dice que el código de la carpeta es de esa versión; no mira la base.
  - **La base.** Se compara en los dos sentidos con el esquema de ese código: se para si le falta una tabla o una columna, o si tiene una tabla o una columna que esta versión no conoce. Una columna de más se perdería en la copia (que solo guarda las del modelo), por eso también para.
  - No se exige la tabla `_prisma_migrations`: producción se creó con `prisma db push` y no la tiene, así que el script se pararía siempre.
  - La restauración hace la misma comprobación de la base y, además, mira que las columnas de cada tabla de la copia son las de esta versión, antes de meter nada.
- **Orden y lotes.** Se borra cada tabla después de todas las que la apuntan con una clave ajena, así ni `RESTRICT` frena ni `CASCADE` o `SET NULL` tienen trabajo. Los padres e hijas de la misma tabla (plan de cuentas, familias de productos, categorías de tesorería) se sueltan antes. Cada `DELETE ... LIMIT 500` (50 en tablas con binarios) es su propia transacción, muy por debajo del límite de TiDB. No hace falta ir empresa por empresa: se borra todo y los lotes ya acotan cada transacción.
- **VERI*FACTU.** Hoy la app no envía nada a la AEAT. Desde la fase F1, las facturas que se emiten con VERI*FACTU en pruebas llevan su registro encadenado (`VerifactuRegistro`, con la cabeza de la cadena en `VerifactuCadena`). La app no deja cambiar ni borrar esos registros (`config/inmutabilidadVerifactu.ts`); el script los borra con SQL, como todo lo demás, y en el orden de las claves ajenas (antes que sus facturas). El script se para y avisa en vez de borrar si alguna empresa tiene VERI*FACTU activo o el entorno de producción de la AEAT, o si hay registros de la AEAT de verdad: filas con `entorno = 'PRODUCCION'` en una tabla de VERI*FACTU, o filas en una tabla que parezca de registros (huella, estado de envío o CSV) y no tenga columna `entorno`. Lo del entorno de pruebas de la AEAT no tiene efecto fiscal y se borra como lo demás.
- **Copia local.** Una sentencia `INSERT` por línea, con los valores leídos como texto (los binarios en hexadecimal), en `tablas/`, más los ficheros en `ficheros/` y un `manifiesto.json`. Las tablas que se conservan entran con `INSERT IGNORE` al restaurar.
- **Ficheros.** Solo se borran los de las carpetas de primer nivel que usa la app (`PREFIJOS_APP` en `almacen.ts`). Un test avisa si aparece código nuevo que guarde ficheros.
- **Nunca se escribe la URL de la base.** Los mensajes de error pasan por un filtro que tapa la URL, el usuario, la contraseña, el servidor y la clave de Vercel Blob.
- **Prueba de acceso.** Arranca la API de esta copia en un puerto local, contra la misma base, y hace `POST /auth/login` y `GET /auth/me`. Firma los tokens con una clave de usar y tirar. Deja una fila `LOGIN` en la auditoría, como un acceso normal. Lo que escribe la API mientras tanto no sale por pantalla, porque su registro de errores puede llevar el servidor y el usuario de la base. Si falla, solo dice la causa: contraseña incorrecta (401) o fallo de la base (500), que no es culpa de la contraseña.
- **Pruebas.** `src/tests/vaciado-produccion.test.ts` (sin base) y `src/tests/vaciado-produccion.db.test.ts`, que lanza el script de verdad contra una base local `conta_vaciar*`. Esta última se salta con cualquier otra base, porque borra la base entera.
