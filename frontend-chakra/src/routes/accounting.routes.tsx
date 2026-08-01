/**
 * Rutas del módulo de Contabilidad
 * Se importan en el router principal de la aplicación
 */

import React from 'react';
import { Routes, Route } from 'react-router-dom';
import { JournalEntryListPage } from '../pages/accounting/JournalEntryList';
import { JournalEntryDetailPage } from '../pages/accounting/JournalEntryDetail';
import { AccountingDashboardPage } from '../pages/accounting/AccountingDashboard';
import { CierresPage } from '../pages/contabilidad/CierresPage';
import { PlanContablePage } from '../pages/contabilidad/PlanContablePage';

export function AccountingRoutes() {
  return (
    <Routes>
      {/* Dashboard principal */}
      <Route
        path="dashboard"
        element={<AccountingDashboardPage />}
      />

      {/* Cierre de ejercicio */}
      <Route path="cierres" element={<CierresPage />} />

      {/* Plan contable */}
      <Route path="plan-contable" element={<PlanContablePage />} />

      {/* Listado de asientos */}
      <Route
        path="journal-entries"
        element={<JournalEntryListPage />}
      />

      {/* Detalle de asiento */}
      <Route
        path="journal-entries/:id"
        element={<JournalEntryDetailPage />}
      />
    </Routes>
  );
}
