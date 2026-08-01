/**
 * Rutas de administración de plataforma (empresas, usuarios). Fase 5 ADR-002.
 * Solo útiles para admin global; cada página maneja el 403 de forma amable.
 */

import React from 'react';
import { Routes, Route } from 'react-router-dom';
import { AdminEmpresasPage } from '../pages/admin/AdminEmpresasPage';
import { AdminUsuariosPage } from '../pages/admin/AdminUsuariosPage';

export function AdminRoutes(): React.ReactElement {
  return (
    <Routes>
      <Route path="empresas" element={<AdminEmpresasPage />} />
      <Route path="usuarios" element={<AdminUsuariosPage />} />
    </Routes>
  );
}
