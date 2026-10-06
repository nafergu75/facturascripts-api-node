-- Arreglo de datos (07-10-2026). Se puede ejecutar mas de una vez sin efectos.
-- Lo aplica scripts/aplicar-arreglos-datos.sh DESPUES del esquema nuevo.

-- 1) Los asientos de facturas emitidas pasan a firme (POSTED), como hace ya la
--    app al emitir. Se quedan en borrador los de facturas que vienen del lector
--    OCR (hay que revisarlos) y cualquier asiento que no cuadre.
UPDATE JournalEntry je
JOIN (
  SELECT entryId, SUM(debe) AS d, SUM(haber) AS h FROM JournalEntryLine GROUP BY entryId
) t ON t.entryId = je.id
SET je.estado = 'POSTED'
WHERE je.estado IN ('DRAFT', 'PENDING_REVIEW')
  AND je.origen IN ('FACTURA_INGRESO', 'FACTURA_GASTO')
  AND ABS(t.d - t.h) < 0.005
  AND NOT EXISTS (SELECT 1 FROM IncomeReaderDocument r WHERE r.linkedInvoiceId = je.invoiceId);

-- 2) El estado de una factura de venta es su estado de COBRO. Las que el motor
--    marco como ACCOUNTED vuelven a pendiente o vencida segun su vencimiento.
UPDATE IncomeInvoice
SET estado = IF(fechaVencimiento < DATE_FORMAT(CURDATE(), '%Y-%m-%d'), 'OVERDUE', 'PENDING')
WHERE estado = 'ACCOUNTED' AND estadoDocumento = 'FINAL';
