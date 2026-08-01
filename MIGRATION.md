# Data Migration: FacturaScripts → Prisma

## Resumen

Script Node.js que migra datos de FacturaScripts a la BD Prisma:
- **Clientes** (`clientes` FS → `Customer` Prisma)
- **Proveedores** (`proveedores` FS → `Supplier` Prisma)
- **Productos** (`productos` FS → `Product` Prisma)

## Modo dry-run (sin escribir en BD)

```bash
npm run migrate:fs:dry
# Muestra qué se migraría sin hacer cambios (0 riesgo)
```

## Ejecutar migración (real)

```bash
npm run migrate:fs
# Migra los datos reales a la BD (escribe en MySQL)
```

## Opciones avanzadas

```bash
# Continuar si hay errores (saltando registros malos)
npm run migrate:fs -- --continue-on-error

# Combinadas
npm run migrate:fs:dry -- --continue-on-error
```

## Variables de entorno

```env
FS_API_URL=http://localhost:8000/api/3      # URL base FS API (default)
FS_API_KEY=<token-de-la-FS-API>            # Token FS API (nunca versionar)
COMPANY_ID=1                                  # Empresa destino en Prisma (default)
```

## Cómo funciona

1. **Lee de FS API** (no toca la BD de FS):
   - GET /clientes, /proveedores, /productos
   - Usa header `Token: <FS_API_KEY>`

2. **Escribe en Prisma MySQL**:
   - `upsert` por NIF (clientes/proveedores) o referencia (productos)
   - Mapea campos FS → Prisma (telefono1 → telefono, etc.)
   - Preserva activo/bloqueado

3. **Logs**:
   - ✅ N migrados
   - ❌ Errores de conexión/API
   - 🔍 Modo dry-run lista sin escribir

## Notas

- **Idempotente**: ejecutar 2 veces = mismo resultado (upsert por clave única)
- **Sin rollback**: si algo falla, revisar la BD con `prisma studio` y fix manual si es necesario
- **Datos antiguos FS**: quedan en FS (nunca se borran; la migracion es copia)
- **Cliente FS vs Prisma**: tras la migración conviven 2 almacenes (los nuevos en Prisma, los viejos en FS)
- **Productos sin modelo antiguo**: FS `productos` es nuevo; la migracion asegura coherencia

## Troubleshooting

### Error de conexión FS

```bash
# Si FS no levanta:
cd ../facturascripts && php -S localhost:8000 index.php
# En otra terminal:
cd ../facturascripts-api-node && npm run migrate:fs:dry
```

### Errores de integridad (ej. NIF duplicado)

El script captura errores por registro y muestra:

```
❌ B12345678 Cliente Duplicado: Unique constraint failed on (companyId, nifCif)
```

**Opciones:**
1. **Revisar BD:** `npx prisma studio` → find el registro duplicado → fix (cambiar NIF, eliminar)
2. **Reintentir:** `npm run migrate:fs:dry` (sin cambios) → re-ejecutar si BD está ok
3. **Ignorar malos:** `npm run migrate:fs -- --continue-on-error` (migra el resto)

### Migracion parcial (algunos registros fallaron)

El script reporta:

```
⚠️  MIGRACION PARCIAL: 150/200 OK, 50 errores:
   - B123: Unique constraint failed
   - A456: Unique constraint failed
   ...
```

**Fix:**
1. Revisar errors en `prisma studio`
2. Resolver constraint (cambiar NIF duplicado, etc.)
3. Re-ejecutar con `--continue-on-error`

### Si todo falló

```bash
# Revisar estado BD
npx prisma studio
# → find registros parcialmente migrados
# → manual fix o rollback (script sin transaccion; opcional: DELETE/truncate)

# Después:
npm run migrate:fs:dry  # simula el fix
npm run migrate:fs      # aplica
```

## Post-migración

1. Verificar Chakra: `/sales/clientes`, `/sales/proveedores`, `/sales/productos` muestran datos migrados
2. Reconciliar tiendas si es necesario (script aparte)
3. Opcionalmente: limpiar datos FS antiguos (NO hacer sin backup)
