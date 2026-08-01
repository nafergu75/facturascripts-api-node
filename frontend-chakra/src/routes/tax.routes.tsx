/**
 * Rutas del módulo de Impuestos/Hacienda
 * Se importan en el router principal de la aplicación
 */

import React from 'react';
import { Routes, Route } from 'react-router-dom';
import { VATBooksPage } from '../pages/tax/VATBooks';
import { TaxSummaryPage } from '../pages/tax/TaxSummary';
import { Sociedades200Page } from '../pages/tax/Sociedades200Page';

export function TaxRoutes() {
  return (
    <Routes>
      {/* Libros de IVA */}
      <Route
        path="vat-books"
        element={<VATBooksPage />}
      />

      {/* Resumen IVA (Modelo 303) */}
      <Route
        path="summary"
        element={<TaxSummaryPage />}
      />

      {/* Modelo 200 - Impuesto de Sociedades */}
      <Route path="sociedades" element={<Sociedades200Page />} />

      {/* TODO: Modelo 190, Exportación de documentos */}
    </Routes>
  );
}
