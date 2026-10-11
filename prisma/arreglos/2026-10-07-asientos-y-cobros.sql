-- Arreglo de datos (07-10-2026). DE UN SOLO USO desde el 08-10-2026: la primera
-- pasada deja una marca en AuditLog (id 'arreglo-asientos-y-cobros-hecho') y las
-- siguientes no hacen nada. scripts/aplicar-arreglos-datos.sh ejecuta todos los
-- arreglos en cada despliegue y, con Compras, el lector de gastos deja facturas
-- y asientos en borrador a proposito (pendientes de aprobar en el Motor
-- contable): repetido, el paso 1 los pasaria a firme sin aprobarlos.
-- Ya se aplico en el despliegue anterior: la pasada de ahora no cambia nada y
-- deja la marca.
-- Lo aplica scripts/aplicar-arreglos-datos.sh DESPUES del esquema nuevo.
--
-- Consulta de solo lectura para ver ANTES lo que cambiaria el paso 1 (vacia si
-- la marca ya existe o no hay nada que pasar a firme):
--   SELECT je.companyId, je.numeroAsiento, je.origen, je.estado
--   FROM JournalEntry je
--   JOIN (SELECT entryId, SUM(debe) AS d, SUM(haber) AS h FROM JournalEntryLine GROUP BY entryId) t ON t.entryId = je.id
--   WHERE je.estado IN ('DRAFT', 'PENDING_REVIEW') AND je.origen IN ('FACTURA_INGRESO', 'FACTURA_GASTO')
--     AND ABS(t.d - t.h) < 0.005
--     AND NOT EXISTS (SELECT 1 FROM IncomeReaderDocument r WHERE r.linkedInvoiceId = je.invoiceId)
--     AND NOT EXISTS (SELECT 1 FROM ExpenseInvoice g WHERE je.origen = 'FACTURA_GASTO' AND g.id = je.invoiceId AND g.estado = 'DRAFT')
--     AND NOT EXISTS (SELECT 1 FROM AuditLog h WHERE h.id = 'arreglo-asientos-y-cobros-hecho');

-- 1) Los asientos de facturas emitidas pasan a firme (POSTED), como hace ya la
--    app al emitir. Se quedan en borrador los de facturas que vienen del lector
--    OCR (hay que revisarlos), los de las facturas de gasto en borrador del
--    lector de gastos (se aprueban en el Motor contable) y cualquier asiento
--    que no cuadre.
UPDATE JournalEntry je
JOIN (
  SELECT entryId, SUM(debe) AS d, SUM(haber) AS h FROM JournalEntryLine GROUP BY entryId
) t ON t.entryId = je.id
SET je.estado = 'POSTED'
WHERE je.estado IN ('DRAFT', 'PENDING_REVIEW')
  AND je.origen IN ('FACTURA_INGRESO', 'FACTURA_GASTO')
  AND ABS(t.d - t.h) < 0.005
  AND NOT EXISTS (SELECT 1 FROM IncomeReaderDocument r WHERE r.linkedInvoiceId = je.invoiceId)
  AND NOT EXISTS (SELECT 1 FROM ExpenseInvoice g WHERE je.origen = 'FACTURA_GASTO' AND g.id = je.invoiceId AND g.estado = 'DRAFT')
  AND NOT EXISTS (SELECT 1 FROM AuditLog h WHERE h.id = 'arreglo-asientos-y-cobros-hecho');

-- 2) El estado de una factura de venta es su estado de COBRO. Las que el motor
--    marco como ACCOUNTED vuelven a pendiente o vencida segun su vencimiento.
UPDATE IncomeInvoice
SET estado = IF(fechaVencimiento < DATE_FORMAT(CURDATE(), '%Y-%m-%d'), 'OVERDUE', 'PENDING')
WHERE estado = 'ACCOUNTED' AND estadoDocumento = 'FINAL'
  AND NOT EXISTS (SELECT 1 FROM AuditLog h WHERE h.id = 'arreglo-asientos-y-cobros-hecho');

-- 3) Marca de arreglo aplicado: las pasadas siguientes no hacen nada.
INSERT INTO AuditLog (id, timestamp, userId, companyId, action, resourceType, resourceId, meta)
SELECT 'arreglo-asientos-y-cobros-hecho', NOW(3), 'SYSTEM', NULL, 'ARREGLO_DATOS_APLICADO', 'ARREGLO',
       '2026-10-07-asientos-y-cobros.sql', JSON_OBJECT('nota', 'Asientos de facturas a firme y estado de cobro de las ventas: hecho una vez.')
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM AuditLog h WHERE h.id = 'arreglo-asientos-y-cobros-hecho');
