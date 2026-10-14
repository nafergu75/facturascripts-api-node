# Vaciar producción para entregar la app a cero

Cuando termines tus pruebas, este script deja la app de producción sin datos para entregarla:

- borra **todas las empresas** con todo lo suyo: facturas, gastos, rectificativas, cobros y pagos, asientos, nóminas, lecturas, la carga de 2026, declaraciones, Carmen, auditoría...;
- borra **todos los usuarios que no son administradores globales**;
- borra los **ficheros guardados** de la app en Vercel Blob: facturas subidas, PDF, lecturas, ficheros de la gestoría...

Se queda **tu usuario de administrador global**, con su contraseña de siempre, sin ninguna empresa. Las empresas reales (IFBIOSOLUCIONES, NEWZELAND) se dan de alta otra vez al entregar.

Solo borra datos. El esquema (las tablas y sus columnas) no se toca.

El script lo lanzas tú desde Git Bash, igual que `aplicar-esquema-prod.sh`. Lee la base de datos del fichero de producción y no la enseña nunca.

## Antes de empezar

- Usa una carpeta del backend que tenga a la vez la versión publicada (la del último esquema que aplicaste) y este script. Si el código de la carpeta no es de esa versión, o la base no tiene ese esquema, el script se para sin tocar nada.
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
cd "/c/Users/NACHO PC/Desktop/conta-app/<carpeta del backend>"
ENV_PROD=../backend/.env.vercel-prod.local bash scripts/vaciar-produccion.sh
```

`ENV_PROD` es el mismo fichero que usas con `aplicar-esquema-prod.sh`. La ruta es relativa a la carpeta del backend.

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
3. Te dice dónde va a dejar la copia: `Documentos/conta-copia-AAAAMMDD-HHMM`.
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
- **Si el borrado se corta a medias** (por ejemplo, se va la conexión): vuelve a lanzar `--borrar`. Sigue con lo que queda y antes copia lo que quede en otra carpeta. Si después quieres volver atrás, la copia buena es la primera, la de antes de empezar.
- **Si la comprobación final no cuadra**: no hagas nada más en la app. Lanza `--comprobar` otra vez y mira qué tabla falla.
- **Para volver atrás**, tienes dos copias:
  1. **La de TiDB Cloud** (paso 1). Es la más segura: se restaura desde el apartado Backup de TiDB Cloud. Ojo: si restauras «en el mismo clúster», se pierde todo lo que hayas hecho después de esa copia.
  2. **La local** (`Documentos/conta-copia-...`). Solo se puede meter sobre la base vaciada, antes de dar de alta ninguna empresa:

     ```bash
     ENV_PROD=../backend/.env.vercel-prod.local bash scripts/vaciar-produccion.sh --restaurar "/c/Users/NACHO PC/Documents/conta-copia-AAAAMMDD-HHMM"
     ```

     Te pide que escribas `RESTAURAR COPIA`. Vuelve a meter todas las filas y vuelve a subir los ficheros a Vercel Blob (con la clave), en la misma dirección que tenían.

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

**Se vacían enteras (66 tablas):**

- todas las que tienen `companyId`: facturas de venta y gasto con sus rectificativas, cobros y pagos, series, asientos y apuntes, libros de IVA y retenciones, modelos y declaraciones de la AEAT, nóminas y trabajadores, lecturas, carga de 2026 con sus partidas, activos y dotaciones, bancos y tesorería, plan de periodos y ejercicios, ajustes de cada empresa, membresías, Carmen, VERI*FACTU...;
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

**Se conservan enteras:**

| Tabla | Por qué |
|---|---|
| `ChartOfAccountsVersion` | Es la versión del PGC, común a todas las empresas. El plan de cuentas de cada empresa nueva apunta a ella. |
| `TipoCambioBce` | Tipos de cambio publicados por el BCE: datos públicos, no son de ninguna empresa. |
| `AjustePlataforma` | Ajustes de toda la plataforma, como la red de seguridad de VERI*FACTU. Los decide el administrador global. |

Ninguna de estas tres es imprescindible para arrancar: la app crea la versión del PGC y los tipos de cambio cuando le hacen falta, y sin ajustes la red de seguridad está activa. Se conservan porque no son datos de prueba de ninguna empresa.

Los **logos** de las empresas no están en Vercel Blob: van dentro de la base (`LegalConfig.logo`) y se borran con ella.

## Cómo está hecho (para quien lo revise)

- **Seguridad de la conexión.** El script se para si la base no tiene exactamente el esquema de esta versión: le falta una tabla o una columna, o tiene una tabla que esta versión no conoce. Antes, en esta copia del código tienen que estar las `MARCAS` de `aplicar-esquema-prod.sh` (se leen de ese fichero). No se exige la tabla `_prisma_migrations`: producción se creó con `prisma db push` y no la tiene, así que el script se pararía siempre.
- **Orden y lotes.** Se borra cada tabla después de todas las que la apuntan con una clave ajena, así ni `RESTRICT` frena ni `CASCADE` o `SET NULL` tienen trabajo. Los padres e hijas de la misma tabla (plan de cuentas, familias de productos, categorías de tesorería) se sueltan antes. Cada `DELETE ... LIMIT 500` (50 en tablas con binarios) es su propia transacción, muy por debajo del límite de TiDB. No hace falta ir empresa por empresa: se borra todo y los lotes ya acotan cada transacción.
- **VERI*FACTU.** Hoy la app no envía nada a la AEAT. `VerifactuConfig` solo guarda la exclusión, ningún código la pasa a `ACTIVO` y no hay tabla de registros. Aun así, si alguna empresa tiene VERI*FACTU activo o el entorno de producción de la AEAT, o si una versión futura trae una tabla de registros con filas, el script se para y avisa en vez de borrar.
- **Copia local.** Una sentencia `INSERT` por línea, con los valores leídos como texto (los binarios en hexadecimal), en `tablas/`, más los ficheros en `ficheros/` y un `manifiesto.json`. Las tablas que se conservan entran con `INSERT IGNORE` al restaurar.
- **Ficheros.** Solo se borran los de las carpetas de primer nivel que usa la app (`PREFIJOS_APP` en `almacen.ts`). Un test avisa si aparece código nuevo que guarde ficheros.
- **Nunca se escribe la URL de la base.** Los mensajes de error pasan por un filtro que tapa la URL, el usuario, la contraseña, el servidor y la clave de Vercel Blob.
- **Prueba de acceso.** Arranca la API de esta copia en un puerto local, contra la misma base, y hace `POST /auth/login` y `GET /auth/me`. Firma los tokens con una clave de usar y tirar. Deja una fila `LOGIN` en la auditoría, como un acceso normal.
- **Pruebas.** `src/tests/vaciado-produccion.test.ts` (sin base) y `src/tests/vaciado-produccion.db.test.ts`, que lanza el script de verdad contra una base local `conta_vaciar*`. Esta última se salta con cualquier otra base, porque borra la base entera.
