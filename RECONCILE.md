# Reconciliación: Clientes FS vs Prisma

## Problema

Tras migración de datos, existen 2 tiendas de clientes:
- **FS:** clientes legacy (nunca migraron)
- **Prisma:** clientes nuevos creados al facturar

Puede haber **duplicados por NIF** → necesita consolidación.

## Estrategias

### 1. FS es maestro (default)

```bash
npm run reconcile:clientes:dry                    # Ver qué pasaría
npm run reconcile:clientes -- --strategy=fs-master   # Borra duplicados en Prisma
```

**Acción:** si hay cliente con NIF X en ambas tiendas, **borra el de Prisma**, mantiene el de FS.

**Caso:** FS tiene datos más antiguos/confiables → es la fuente de verdad.

### 2. Prisma es maestro (default)

```bash
npm run reconcile:clientes:dry                    # Ver qué pasaría
npm run reconcile:clientes                        # Borra duplicados en FS (solo reporte)
```

**Acción:** detecta duplicados, pero **NO borra FS automático** (está en otra BD). Solo marca para revisar manual.

**Caso:** Prisma tiene datos nuevos/actuales → es la fuente de verdad. FS se abandona.

## Modo dry-run (0 riesgo)

```bash
npm run reconcile:clientes:dry
# Output:
# 📊 Duplicados (estrategia: prisma-master):
# NIF              | FS Nombre              | Prisma Nombre          | Acción
# B12345678        | Cliente Legacy SL      | Cliente Legacy SL      | delete-fs
# ...
# 🔍 DRY-RUN: mostraría 5 cambios sin aplicar
```

## Variables de entorno

```env
FS_API_URL=http://localhost:8000/api/3
FS_API_KEY=<token-de-la-FS-API>
COMPANY_ID=1
```

## Output

```
📥 Leyendo clientes de FS...
  120 clientes en FS
📥 Leyendo clientes de Prisma...
  45 clientes en Prisma

🔍 Analizando duplicados...
  15 duplicados encontrados

📊 Duplicados (estrategia: prisma-master):

NIF              | FS Nombre              | Prisma Nombre          | Acción
-----------
B12345678        | Cliente Facturable SL  | Cliente Facturable SL  | delete-fs
A87654321        | Proveedor XYZ SL       | Proveedor XYZ SL       | delete-fs
...

📋 Resumen:
  Solo FS: 75 (abandonados, no en Prisma)
  Solo Prisma: 30 (nuevos, no en FS)
  Duplicados: 15 (borra FS)
```

## Workflow típico

```bash
# 1. Diagnóstico (sin riesgo)
npm run reconcile:clientes:dry

# 2. Si hay duplicados, elegir estrategia:
#    - FS maestro (FS es fuente confiable):
npm run reconcile:clientes -- --strategy=fs-master
#    - Prisma maestro (Prisma es fuente actual):
npm run reconcile:clientes    # default = prisma-master

# 3. Verificar en Prisma Studio
npx prisma studio
# → customers (verificar que se borraron duplicados)
```

## Casos post-reconciliación

### Si duplicados = 0 (tiendas limpias)

Nada que hacer. FS y Prisma están separados pero sin conflictos.

### Si `Solo FS > 0`

Clientes legacy en FS que no están en Prisma (no se facturaron nunca en Chakra).
- **Opción A:** dejarlos (FS inerte, Chakra ignora)
- **Opción B:** migrar con `npm run migrate:fs` después (trae FS →Prisma)

### Si `Solo Prisma > 0`

Clientes nuevos en Prisma (creados al facturar en Chakra) que no estaban en FS.
- Normales. Son clientes nuevos. FS no los tiene.

## Notas

- **FS no se borra automático** (otra BD): solo reporte de qué existe
- **Prisma sí se modifica** (mismo proyecto): borra duplicados según estrategia
- **Transacción:** cada delete es independiente (si uno falla, continúa)
- **Facturas:** si borra cliente Prisma, reasigna sus facturas (income-invoices) antes de borrar

## Troubleshooting

```bash
# FS no levanta
cd ../facturascripts && php -S localhost:8000 index.php

# Revisar clientes en Prisma
npx prisma studio
# → customers: filtrar por companyId='1'

# Rollback manual (si algo falló)
# → usar prisma studio para restaurar o cambiar IDs en income-invoices
```
