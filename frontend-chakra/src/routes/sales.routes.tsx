/**
 * Rutas del módulo operativo de Ventas/Compras (Clientes, Proveedores, …).
 * Primer grupo migrado desde el front vanilla (ADR-002).
 */

import React from 'react';
import { Routes, Route } from 'react-router-dom';
import { ContactosPage } from '../pages/sales/ContactosPage';
import { FacturasPage } from '../pages/sales/FacturasPage';
import { NuevaFacturaPage } from '../pages/sales/NuevaFacturaPage';
import { ComprasPage } from '../pages/compras/ComprasPage';
import { ProductosPage } from '../pages/productos/ProductosPage';

export function SalesRoutes(): React.ReactElement {
  return (
    <Routes>
      <Route path="facturas" element={<FacturasPage />} />
      <Route path="facturas/nueva" element={<NuevaFacturaPage />} />
      <Route path="compras" element={<ComprasPage />} />
      <Route path="productos" element={<ProductosPage />} />
      <Route path="clientes" element={<ContactosPage tipo="clientes" titulo="Clientes" singular="Cliente" />} />
      <Route path="proveedores" element={<ContactosPage tipo="proveedores" titulo="Proveedores" singular="Proveedor" />} />
    </Routes>
  );
}
