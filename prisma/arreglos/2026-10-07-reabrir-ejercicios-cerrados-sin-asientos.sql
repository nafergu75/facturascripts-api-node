-- Arreglo de datos (07-10-2026, rama configuracion). DE UN SOLO USO: la primera
-- pasada deja una marca en AuditLog (id 'arreglo-reabrir-ejercicios-hecho') y
-- las siguientes no hacen nada. scripts/aplicar-arreglos-datos.sh ejecuta todos
-- los arreglos en cada despliegue: sin la marca, reabriria en el futuro
-- ejercicios cerrados que no tienen nada que ver con el boton.
-- Lo aplica scripts/aplicar-arreglos-datos.sh DESPUES del esquema nuevo.
--
-- Reabre los ejercicios que cerro el boton "Cerrar ejercicio" de Registro
-- Mercantil. Ese boton marcaba el ejercicio como cerrado sin regularizar, sin
-- asiento de cierre ni apertura del año siguiente, y despues Cierre y traspaso
-- de saldos no lo dejaba deshacer. El boton ya no cierra (responde 409); al
-- reabrirlos, el cierre se repite bien desde Contabilidad > Cierre y traspaso
-- de saldos.
--
-- Se reabre un ejercicio CLOSED solo si se cumplen las tres cosas (las mismas
-- reglas que POST /fiscal-years/:fyId/reabrir):
--  1) No tiene asientos de cierre en su año. Son asientos de cierre (el mismo
--     criterio que la app, src/domain/asientosCierre.ts) los POSTED con origen
--     REGULARIZACION, CIERRE o CIERRE_AUTOMATICO, o con concepto que empieza
--     por «Regularizacion ejercicio», «Cierre ejercicio» o «Cierre contable»
--     (los cierres de antes del 06-10-2026 se grabaron como AJUSTE_MANUAL). Un
--     ejercicio cerrado de verdad siempre los tiene: si no hay saldos, el
--     cierre no cierra.
--  2) Ningun ejercicio posterior tiene asientos de cierre: ese cierre ya
--     arrastro los saldos de este año, y este no se podria volver a cerrar.
--  3) Tiene algun asiento POSTED (que no sea de cierre) hasta su fin: un año
--     sin asientos (anterior a la puesta en marcha, cerrado para sacar sus
--     libros) no se podria volver a cerrar y sus libros ya no se generarian.
-- Los que no cumplen 2) o 3) se quedan cerrados: revisalos con la consulta B.
--
-- Al reabrir se hace lo mismo que "Deshacer cierre": estado OPEN, sin fecha de
-- cierre ni plazos, sin bloqueo de asientos, y fuera los libros PENDING sin
-- fichero (los vuelve a crear el cierre). Sus 12 meses quedan BLOQUEADOS (los
-- 'cerrado' no se tocan): el ejercicio pudo tener libros legalizados o cuentas
-- depositadas, y hasta repetir el cierre nada se apunta en el por error. Quien
-- tenga contabilidad:write desbloquea en Configuracion > Ejercicios y periodos
-- el mes que tenga que ajustar. Los libros generados, los expedientes y las
-- cuentas anuales NO se tocan. Deja una linea en AuditLog por ejercicio.
--
-- Consultas de solo lectura para revisarlo ANTES de aplicarlo:
--
-- A) Cierres antiguos (AJUSTE_MANUAL reconocidos por el concepto) y del antiguo
--    generar-asiento: cuentan como cierre, esos ejercicios NO se reabren.
--   SELECT j.companyId, DATE_FORMAT(j.fecha, '%Y-%m-%d') AS fecha, j.origen, j.descripcion
--   FROM JournalEntry j
--   WHERE j.estado = 'POSTED' AND (j.origen = 'CIERRE_AUTOMATICO' OR (j.origen NOT IN ('REGULARIZACION', 'CIERRE')
--     AND (LOWER(j.descripcion) LIKE 'regularizaci_n ejercicio%' OR LOWER(j.descripcion) LIKE 'cierre ejercicio%'
--          OR LOWER(j.descripcion) LIKE 'cierre contable%')));
--
-- B) Ejercicios cerrados sin asientos de cierre en su año, y si se reabririan:
--   SELECT f.companyId, f.label, f.closingDate,
--     EXISTS (SELECT 1 FROM JournalEntry j WHERE j.companyId = f.companyId AND j.estado = 'POSTED'
--       AND (j.origen IN ('REGULARIZACION', 'CIERRE', 'CIERRE_AUTOMATICO') OR LOWER(j.descripcion) LIKE 'regularizaci_n ejercicio%'
--            OR LOWER(j.descripcion) LIKE 'cierre ejercicio%' OR LOWER(j.descripcion) LIKE 'cierre contable%')
--       AND DATE_FORMAT(j.fecha, '%Y-%m-%d') > COALESCE(NULLIF(f.fechaFin, ''), CONCAT(f.label, '-12-31'))) AS posterior_cerrado,
--     NOT EXISTS (SELECT 1 FROM JournalEntry j WHERE j.companyId = f.companyId AND j.estado = 'POSTED'
--       AND NOT (j.origen IN ('REGULARIZACION', 'CIERRE', 'CIERRE_AUTOMATICO') OR LOWER(j.descripcion) LIKE 'regularizaci_n ejercicio%'
--            OR LOWER(j.descripcion) LIKE 'cierre ejercicio%' OR LOWER(j.descripcion) LIKE 'cierre contable%')
--       AND DATE_FORMAT(j.fecha, '%Y-%m-%d') <= COALESCE(NULLIF(f.fechaFin, ''), CONCAT(f.label, '-12-31'))) AS sin_asientos
--   FROM FiscalYear f
--   WHERE f.estado = 'CLOSED' AND NOT EXISTS (SELECT 1 FROM JournalEntry j WHERE j.companyId = f.companyId AND j.estado = 'POSTED'
--     AND (j.origen IN ('REGULARIZACION', 'CIERRE', 'CIERRE_AUTOMATICO') OR LOWER(j.descripcion) LIKE 'regularizaci_n ejercicio%'
--          OR LOWER(j.descripcion) LIKE 'cierre ejercicio%' OR LOWER(j.descripcion) LIKE 'cierre contable%')
--     AND (DATE_FORMAT(j.fecha, '%Y') = f.label OR DATE_FORMAT(j.fecha, '%Y-%m-%d') BETWEEN f.fechaInicio AND f.fechaFin));
--   Se reabren las filas con posterior_cerrado = 0 y sin_asientos = 0.
--
-- Fechas como texto (DATE_FORMAT contra AAAA-MM-DD): sin conversiones de un
-- nombre como 'Ejercicio 2025' a numero, que en modo estricto pararian la sentencia.

-- 1) Rastro en la auditoria: marca los ejercicios que se van a reabrir (los
--    pasos 2 a 4 trabajan sobre los marcados, asi una pasada a medias se completa).
INSERT INTO AuditLog (id, timestamp, userId, companyId, action, resourceType, resourceId, meta)
SELECT CONCAT('arreglo-reabrir-', f.id), NOW(3), 'SYSTEM', f.companyId, 'REOPEN_FISCAL_YEAR_SIN_ASIENTOS', 'FISCAL_YEAR', f.id,
       JSON_OBJECT('label', f.label, 'closingDate', f.closingDate, 'motivo', 'Cerrado desde Registro Mercantil sin asientos de regularizacion ni cierre', 'arreglo', '2026-10-07-reabrir-ejercicios-cerrados-sin-asientos.sql')
FROM FiscalYear f
WHERE f.estado = 'CLOSED'
  AND NOT EXISTS (SELECT 1 FROM AuditLog h WHERE h.id = 'arreglo-reabrir-ejercicios-hecho')
  AND NOT EXISTS (SELECT 1 FROM AuditLog a WHERE a.id = CONCAT('arreglo-reabrir-', f.id))
  -- 1) Sin asientos de cierre en su año.
  AND NOT EXISTS (
    SELECT 1 FROM JournalEntry j
    WHERE j.companyId = f.companyId AND j.estado = 'POSTED'
      AND (j.origen IN ('REGULARIZACION', 'CIERRE', 'CIERRE_AUTOMATICO') OR LOWER(j.descripcion) LIKE 'regularizaci_n ejercicio%'
           OR LOWER(j.descripcion) LIKE 'cierre ejercicio%' OR LOWER(j.descripcion) LIKE 'cierre contable%')
      AND (DATE_FORMAT(j.fecha, '%Y') = f.label OR DATE_FORMAT(j.fecha, '%Y-%m-%d') BETWEEN f.fechaInicio AND f.fechaFin)
  )
  -- 2) Ningun ejercicio posterior cerrado con asientos.
  AND NOT EXISTS (
    SELECT 1 FROM JournalEntry j
    WHERE j.companyId = f.companyId AND j.estado = 'POSTED'
      AND (j.origen IN ('REGULARIZACION', 'CIERRE', 'CIERRE_AUTOMATICO') OR LOWER(j.descripcion) LIKE 'regularizaci_n ejercicio%'
           OR LOWER(j.descripcion) LIKE 'cierre ejercicio%' OR LOWER(j.descripcion) LIKE 'cierre contable%')
      AND DATE_FORMAT(j.fecha, '%Y-%m-%d') > COALESCE(NULLIF(f.fechaFin, ''), CONCAT(f.label, '-12-31'))
  )
  -- 3) Con algun asiento (que no sea de cierre) hasta su fin.
  AND EXISTS (
    SELECT 1 FROM JournalEntry j
    WHERE j.companyId = f.companyId AND j.estado = 'POSTED'
      AND NOT (j.origen IN ('REGULARIZACION', 'CIERRE', 'CIERRE_AUTOMATICO') OR LOWER(j.descripcion) LIKE 'regularizaci_n ejercicio%'
               OR LOWER(j.descripcion) LIKE 'cierre ejercicio%' OR LOWER(j.descripcion) LIKE 'cierre contable%')
      AND DATE_FORMAT(j.fecha, '%Y-%m-%d') <= COALESCE(NULLIF(f.fechaFin, ''), CONCAT(f.label, '-12-31'))
  );

-- 2) Libros pendientes sin fichero que dejo ese cierre (el cierre bueno los vuelve a crear).
DELETE FROM LegalBook
WHERE status = 'PENDING' AND filePath = ''
  AND NOT EXISTS (SELECT 1 FROM AuditLog h WHERE h.id = 'arreglo-reabrir-ejercicios-hecho')
  AND fiscalYearId IN (
    SELECT f.id FROM FiscalYear f
    WHERE f.estado = 'CLOSED' AND EXISTS (SELECT 1 FROM AuditLog a WHERE a.id = CONCAT('arreglo-reabrir-', f.id))
  );

-- 3) Sus 12 meses, bloqueados (los que no existian se crean bloqueados; los cerrados se quedan igual).
INSERT INTO Periodo (id, companyId, ejercicio, mes, estado, fechaApertura)
SELECT t.nuevoId, t.empresa, t.anio, t.numMes, 'bloqueado', t.apertura
FROM (
  SELECT UUID() AS nuevoId, f.companyId AS empresa, CAST(LEFT(f.fechaInicio, 4) AS UNSIGNED) AS anio, m.numMes,
         DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-%dT%H:%i:%s.000Z') AS apertura
  FROM FiscalYear f
  CROSS JOIN (SELECT 1 AS numMes UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6
              UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9 UNION ALL SELECT 10 UNION ALL SELECT 11 UNION ALL SELECT 12) m
  WHERE f.estado = 'CLOSED' AND f.fechaInicio REGEXP '^[0-9]{4}-'
    AND NOT EXISTS (SELECT 1 FROM AuditLog h WHERE h.id = 'arreglo-reabrir-ejercicios-hecho')
    AND EXISTS (SELECT 1 FROM AuditLog a WHERE a.id = CONCAT('arreglo-reabrir-', f.id))
) t
ON DUPLICATE KEY UPDATE estado = IF(estado = 'abierto', 'bloqueado', estado);

-- 4) Reabrir.
UPDATE FiscalYear f
SET f.estado = 'OPEN', f.closingDate = NULL, f.legalizationDeadline = NULL, f.accountsDepositDeadline = NULL,
    f.asientosBloqueados = 0, f.updatedAt = NOW(3)
WHERE f.estado = 'CLOSED'
  AND NOT EXISTS (SELECT 1 FROM AuditLog h WHERE h.id = 'arreglo-reabrir-ejercicios-hecho')
  AND EXISTS (SELECT 1 FROM AuditLog a WHERE a.id = CONCAT('arreglo-reabrir-', f.id));

-- 5) Marca de arreglo aplicado: las pasadas siguientes no hacen nada.
INSERT INTO AuditLog (id, timestamp, userId, companyId, action, resourceType, resourceId, meta)
SELECT 'arreglo-reabrir-ejercicios-hecho', NOW(3), 'SYSTEM', NULL, 'ARREGLO_DATOS_APLICADO', 'ARREGLO',
       '2026-10-07-reabrir-ejercicios-cerrados-sin-asientos.sql', JSON_OBJECT('nota', 'Reapertura de los ejercicios cerrados sin asientos: hecha una vez.')
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM AuditLog h WHERE h.id = 'arreglo-reabrir-ejercicios-hecho');
