/**
 * Rutas del módulo de Tesorería (cuentas bancarias, extractos, conciliación).
 * Fase 3 de la migración ADR-002 (módulo Prisma /bancos, sin FacturaScripts).
 */

import React from 'react';
import { Routes, Route } from 'react-router-dom';
import { CuentasBancariasPage } from '../pages/tesoreria/CuentasBancariasPage';
import { ConciliacionPage } from '../pages/tesoreria/ConciliacionPage';
import { ExtractosPage } from '../pages/tesoreria/ExtractosPage';

export function TesoreriaRoutes(): React.ReactElement {
  return (
    <Routes>
      <Route path="cuentas" element={<CuentasBancariasPage />} />
      <Route path="extractos" element={<ExtractosPage />} />
      <Route path="conciliacion" element={<ConciliacionPage />} />
    </Routes>
  );
}
