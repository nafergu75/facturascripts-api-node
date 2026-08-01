/**
 * Rutas del módulo de Reportes
 * Se importan en el router principal de la aplicación
 */

import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { BalanceSheetPage } from '../pages/reports/BalanceSheet';
import { ProfitAndLossPage } from '../pages/reports/ProfitAndLoss';
import { LedgerPage } from '../pages/reports/LedgerPage';
import { CustomerAnalysisPage } from '../pages/reports/CustomerAnalysis';
import { ReportsPage } from '../pages/reports/ReportsPage';

export function ReportsRoutes() {
  return (
    <Routes>
      {/* Módulo de informes financieros (tabs: ingresos/gastos/resultado/IVA/retenciones/tesorería) */}
      <Route path="informes" element={<ReportsPage />} />

      {/* Reportes contables clásicos */}
      <Route path="balance" element={<BalanceSheetPage />} />
      <Route path="profit-and-loss" element={<ProfitAndLossPage />} />
      <Route path="ledger" element={<LedgerPage />} />
      <Route path="analytics/customers" element={<CustomerAnalysisPage />} />

      {/* Redirigir la raíz al módulo de informes */}
      <Route index element={<Navigate to="informes" replace />} />
    </Routes>
  );
}
