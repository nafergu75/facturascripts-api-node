-- Arreglo de datos (07-10-2026, rama configuracion). Se puede ejecutar mas de una vez sin efectos.
-- Lo aplica scripts/aplicar-arreglos-datos.sh DESPUES del esquema nuevo.
--
-- Reabre los ejercicios que cerro el boton "Cerrar ejercicio" de Registro
-- Mercantil. Ese boton marcaba el ejercicio como cerrado sin regularizar, sin
-- asiento de cierre ni apertura del año siguiente, y despues Cierre y traspaso
-- de saldos no lo dejaba deshacer. El boton ya no cierra (responde 409); al
-- reabrirlos, el cierre se repite bien desde Contabilidad > Cierre y traspaso
-- de saldos.
--
-- Como se reconocen con certeza: el cierre de la app (cierreEjercicio) deja
-- SIEMPRE al menos un asiento POSTED de REGULARIZACION o CIERRE fechado en ese
-- año (si no hay saldos que cerrar, no cierra), y busca el ejercicio por su
-- año como nombre ('2025'). Un ejercicio CLOSED sin ninguno de esos asientos
-- en su año solo pudo cerrarlo el boton de Registro Mercantil. Los que tienen
-- un nombre que no es un año ('Ejercicio 2025') tampoco los pudo cerrar la app.
--
-- Al reabrir se hace lo mismo que "Deshacer cierre": estado OPEN, sin fecha
-- de cierre ni plazos, sin bloqueo de asientos, y fuera los libros PENDING sin
-- fichero (los vuelve a crear el cierre). Los libros ya generados, los
-- expedientes y las cuentas anuales NO se tocan. Los meses no se tocan (ese
-- boton no los bloqueaba). Deja una linea en el registro de auditoria por
-- ejercicio reabierto.
--
-- Para ver antes cuales se reabririan (solo lectura):
--   SELECT f.companyId, f.label, f.closingDate FROM FiscalYear f
--   WHERE f.estado = 'CLOSED' AND NOT EXISTS (
--     SELECT 1 FROM JournalEntry j WHERE j.companyId = f.companyId AND j.estado = 'POSTED'
--       AND j.origen IN ('REGULARIZACION', 'CIERRE') AND DATE_FORMAT(j.fecha, '%Y') = f.label);
--
-- Se compara el año como texto (DATE_FORMAT = label): sin conversiones de un
-- nombre como 'Ejercicio 2025' a numero, que en modo estricto pararian el UPDATE.

-- 1) Rastro en la auditoria (antes de reabrir, para saber cuales eran).
INSERT INTO AuditLog (id, timestamp, userId, companyId, action, resourceType, resourceId, meta)
SELECT CONCAT('arreglo-reabrir-', f.id), NOW(3), 'SYSTEM', f.companyId, 'REOPEN_FISCAL_YEAR_SIN_ASIENTOS', 'FISCAL_YEAR', f.id,
       JSON_OBJECT('label', f.label, 'closingDate', f.closingDate, 'motivo', 'Cerrado desde Registro Mercantil sin asientos de regularizacion ni cierre', 'arreglo', '2026-10-07-reabrir-ejercicios-cerrados-sin-asientos.sql')
FROM FiscalYear f
WHERE f.estado = 'CLOSED'
  AND NOT EXISTS (
    SELECT 1 FROM JournalEntry j
    WHERE j.companyId = f.companyId AND j.estado = 'POSTED'
      AND j.origen IN ('REGULARIZACION', 'CIERRE') AND DATE_FORMAT(j.fecha, '%Y') = f.label
  )
  AND NOT EXISTS (SELECT 1 FROM AuditLog a WHERE a.id = CONCAT('arreglo-reabrir-', f.id));

-- 2) Libros pendientes sin fichero que dejo ese cierre (el cierre bueno los vuelve a crear).
DELETE FROM LegalBook
WHERE status = 'PENDING' AND filePath = ''
  AND fiscalYearId IN (
    SELECT f.id FROM FiscalYear f
    WHERE f.estado = 'CLOSED'
      AND NOT EXISTS (
        SELECT 1 FROM JournalEntry j
        WHERE j.companyId = f.companyId AND j.estado = 'POSTED'
          AND j.origen IN ('REGULARIZACION', 'CIERRE') AND DATE_FORMAT(j.fecha, '%Y') = f.label
      )
  );

-- 3) Reabrir.
UPDATE FiscalYear f
SET f.estado = 'OPEN', f.closingDate = NULL, f.legalizationDeadline = NULL, f.accountsDepositDeadline = NULL,
    f.asientosBloqueados = 0, f.updatedAt = NOW(3)
WHERE f.estado = 'CLOSED'
  AND NOT EXISTS (
    SELECT 1 FROM JournalEntry j
    WHERE j.companyId = f.companyId AND j.estado = 'POSTED'
      AND j.origen IN ('REGULARIZACION', 'CIERRE') AND DATE_FORMAT(j.fecha, '%Y') = f.label
  );
