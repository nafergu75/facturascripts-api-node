# Seguridad y secretos

Guía de gestión de credenciales de este backend. Léela antes de tocar variables
de entorno o de hacer un despliegue.

---

## Incidente del 01-08-2026

Un `git add .` ejecutado desde la raíz arrastró 1.271 ficheros al repositorio
**público**, incluidos proyectos ajenos y tres credenciales. El historial se
reescribió el mismo día (commit raíz único, `6595f20`).

### Qué se expuso

| Credencial | Estado | Acción |
|---|---|---|
| `FS_API_KEY` (token real de FacturaScripts) | Expuesta en repo público | **Rotar — obligatorio** |
| `ENCRYPTION_KEY` de desarrollo | Expuesta | Rotar si se usó fuera de local |
| `JWT_SECRET` de desarrollo (placeholder) | Expuesta | Sin riesgo si nunca salió de local |
| `ANTHROPIC_API_KEY` | **No expuesta** — el `.gitignore` protegió el `.env` | Ninguna |

### Por qué hay que rotar igualmente

Reescribir el historial **no borra los commits de GitHub**. El commit antiguo
(`8f75a3f`) quedó huérfano pero sigue sirviéndose por URL directa, y GitHub lo
mantiene indefinidamente salvo que se pida su purga a soporte. Verificado tras
el force-push: la página del commit seguía cargando con los 1.271 ficheros.

Para purgarlo de verdad hay dos vías, y conviene hacer ambas:

1. **Rotar la clave.** Es lo único que anula el valor de la credencial filtrada.
   Es la acción prioritaria; todo lo demás es secundario.
2. **Pedir la purga a GitHub Support** (<https://support.github.com/>),
   indicando repo y SHA del commit huérfano. Sin esto, el commit sigue accesible.

Considerar también poner el repositorio en privado mientras se resuelve.

---

## Variables de entorno

El backend valida su configuración al arrancar (`src/config/env.ts`). Si falta
una variable obligatoria, el proceso **muere en el arranque** — en Vercel eso se
manifiesta como `500 FUNCTION_INVOCATION_FAILED` en todas las rutas, incluida
`/health`.

### Obligatorias

| Variable | Descripción |
|---|---|
| `DATABASE_URL` | Cadena de conexión. En producción debe apuntar a una BD accesible desde internet — un `127.0.0.1` local no vale en serverless. |
| `JWT_SECRET` | Firma de tokens JWT. 32 bytes en hex. |
| `ENCRYPTION_KEY` | Cifrado AES-256-GCM. Exactamente 32 bytes en hex (64 caracteres). |

### Opcionales

| Variable | Descripción |
|---|---|
| `FS_API_URL` / `FS_API_KEY` | Conexión a la API de FacturaScripts. |
| `ANTHROPIC_API_KEY` | Asistente Carmen y lectura OCR de facturas. |
| `CORS_ORIGIN` | Orígenes permitidos, separados por comas. |

### Generar valores seguros

```bash
openssl rand -hex 32
```

Genera uno **distinto** para `JWT_SECRET` y para `ENCRYPTION_KEY`. Nunca
reutilices los valores de desarrollo en producción.

### Configurarlas en Vercel

Dashboard → proyecto → Settings → Environment Variables. Márcalas para
*Production* y *Preview*.

Vercel **no aplica variables nuevas a despliegues ya construidos**: después de
añadirlas hay que hacer un redeploy para que surtan efecto.

---

## Reglas para no repetirlo

**Nunca `git add .` en este repositorio.** Su raíz comparte carpeta en disco con
una veintena de proyectos sin relación. Añade ficheros por ruta explícita, o
revisa `git status` antes de confirmar. El arreglo de fondo — mover el backend a
su propia carpeta — sigue pendiente.

**Los secretos van solo en `.env`**, nunca en código, documentación ni tests. El
fallback de `src/tests/jest.setup.ts` usa un valor de relleno evidente
(`deadbeef…`) precisamente para que nadie lo confunda con una clave real.

**Revisa qué cubre `.gitignore` antes de fiarte.** El patrón `.env` no cubría
`.env.local.bak`, y por eso una copia de seguridad se coló en el commit. Ahora
el patrón es `.env*` con excepción de `.env.example`.

**Antes de un push grande, escanea:**

```bash
git diff --cached --name-only | xargs grep -lIE "sk-ant-|AKIA|BEGIN.*PRIVATE"
```

---

## Si vuelve a filtrarse una credencial

1. Rota la credencial. Primero esto, antes que tocar git.
2. Reescribe el historial (`git filter-repo`, o un commit raíz nuevo si el
   historial es corto) y haz force-push.
3. Pide la purga de los commits huérfanos a GitHub Support.
4. Revisa los logs de acceso del servicio afectado por si hubo uso indebido.
