# Flujo Completo: Factura → Asiento → Informes

## Paso a Paso

### 1. Confirmas una Factura
👉 Ve a **Facturación → Nueva Factura**
👉 Llena datos, cliente, concepto, importe
👉 Click **Confirmar**

### 2. Sistema Genera Asiento (AUTOMÁTICO)
- Motor contable crea un asiento siguiendo reglas PGC
- Estado inicial: DRAFT (borrador)

### 3. Revisar Asiento
👉 Ve a **Contabilidad → Asientos**
👉 Busca tu factura en el listado (filtro por fecha/origen)
👉 Click en el asiento para ver líneas (DEBE = HABER)

### 4. Aprobar
- Si los datos son correctos
- Click **Aprobar**
- Estado cambia a POSTED

### 5. Aparece en Informes
- Ya está en tu **Balance General**
- Ya está en tu **Cuenta de Pérdidas y Ganancias**
- Ya está en **Libros de IVA** (si tiene IVA)

## Validaciones

✅ El sistema valida que DEBE = HABER (partida doble)
✅ El sistema genera líneas automáticamente (no las creas manualmente)
✅ Puedes ajustar cuentas si hay error, sin necesidad de borrar
