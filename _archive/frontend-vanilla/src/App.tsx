import React, { lazy, Suspense, useMemo, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { ApiClient } from './app/apiClient';
import { AppLayout, useApp } from './app/AppLayout';
import { Sesion } from './app/types';
import { LoginPage } from './pages/LoginPage';
import { VistaGeneralPage } from './pages/VistaGeneralPage';
import { Cargando } from './app/ui';

/**
 * LAZY-LOAD de las vistas que no son la inicial: cada pagina se descarga en su
 * propio chunk solo al navegar a ella, reduciendo el bundle del primer pintado
 * (buena practica de dashboards: no cargar lo que no se ve aun).
 * Login y Vista general van EAGER (es lo primero que ve el usuario).
 */
const InformesExportacionesPage = lazy(() => import('./pages/InformesExportacionesPage').then((m) => ({ default: m.InformesExportacionesPage })));
const FacturasPage = lazy(() => import('./pages/FacturasPage').then((m) => ({ default: m.FacturasPage })));
const ExtractosPage = lazy(() => import('./pages/ExtractosPage').then((m) => ({ default: m.ExtractosPage })));
const ClientesPage = lazy(() => import('./pages/ClientesPage').then((m) => ({ default: m.ClientesPage })));
const ProveedoresPage = lazy(() => import('./pages/ProveedoresPage').then((m) => ({ default: m.ProveedoresPage })));
const ProductosPage = lazy(() => import('./pages/ProductosPage').then((m) => ({ default: m.ProductosPage })));
const ComprasPage = lazy(() => import('./pages/ComprasPage').then((m) => ({ default: m.ComprasPage })));
const CuentasBancariasPage = lazy(() => import('./pages/CuentasBancariasPage').then((m) => ({ default: m.CuentasBancariasPage })));
const ConciliacionPage = lazy(() => import('./pages/ConciliacionPage').then((m) => ({ default: m.ConciliacionPage })));
const AsientosPage = lazy(() => import('./pages/AsientosPage').then((m) => ({ default: m.AsientosPage })));
const PlanContablePage = lazy(() => import('./pages/PlanContablePage').then((m) => ({ default: m.PlanContablePage })));
const CierresPage = lazy(() => import('./pages/CierresPage').then((m) => ({ default: m.CierresPage })));
const Sociedades200Page = lazy(() => import('./pages/Sociedades200Page').then((m) => ({ default: m.Sociedades200Page })));
const CuentasAnualesPage = lazy(() => import('./pages/CuentasAnualesPage').then((m) => ({ default: m.CuentasAnualesPage })));
const LectorPage = lazy(() => import('./pages/LectorPage').then((m) => ({ default: m.LectorPage })));
const AdminUsuariosPage = lazy(() => import('./pages/AdminUsuariosPage').then((m) => ({ default: m.AdminUsuariosPage })));
const AdminEmpresasPage = lazy(() => import('./pages/AdminEmpresasPage').then((m) => ({ default: m.AdminEmpresasPage })));
const ImpuestosPage = lazy(() => import('./impuestos/ImpuestosPage').then((m) => ({ default: m.ImpuestosPage })));
const ModeloImpuestoDetallePage = lazy(() => import('./impuestos/ModeloImpuestoDetallePage').then((m) => ({ default: m.ModeloImpuestoDetallePage })));

/** TODO: mover a configuracion/env (VITE_API_URL). */
const API_URL = 'http://localhost:3000';

/** Adaptadores: conectan el modulo Impuestos existente con sesion + router. */
function ImpuestosRuta(): React.ReactElement {
  const { sesion } = useApp();
  const navigate = useNavigate();
  return <ImpuestosPage companyId={sesion.companyId} token={sesion.token} apiBaseUrl={API_URL} onAbrirDetalle={(m) => navigate(`/impuestos/${m.id}`)} />;
}

function ImpuestoDetalleRuta(): React.ReactElement {
  const { sesion } = useApp();
  const navigate = useNavigate();
  const { modeloId } = useParams<{ modeloId: string }>();
  return <ModeloImpuestoDetallePage companyId={sesion.companyId} token={sesion.token} apiBaseUrl={API_URL} modeloId={modeloId ?? ''} onVolver={() => navigate('/impuestos')} />;
}

export function App(): React.ReactElement {
  const api = useMemo(() => new ApiClient(API_URL), []);
  const [sesion, setSesion] = useState<Sesion | null>(null);

  if (!sesion) return <LoginPage api={api} onLogin={setSesion} />;

  return (
    <BrowserRouter>
      <Routes>
        <Route element={<AppLayout api={api} sesionInicial={sesion} onLogout={() => setSesion(null)} />}>
          <Route index element={<VistaGeneralPage />} />
          {/* Resto de rutas: lazy + Suspense con fallback de carga */}
          <Route
            path="*"
            element={
              <Suspense fallback={<Cargando />}>
                <Routes>
                  <Route path="/informes" element={<InformesExportacionesPage />} />
                  <Route path="/ventas/facturas" element={<FacturasPage />} />
                  <Route path="/ventas/clientes" element={<ClientesPage />} />
                  <Route path="/ventas/productos" element={<ProductosPage />} />
                  <Route path="/compras/facturas" element={<ComprasPage />} />
                  <Route path="/compras/proveedores" element={<ProveedoresPage />} />
                  <Route path="/bancos/cuentas" element={<CuentasBancariasPage />} />
                  <Route path="/bancos/extractos" element={<ExtractosPage />} />
                  <Route path="/bancos/conciliacion" element={<ConciliacionPage />} />
                  <Route path="/contabilidad/asientos" element={<AsientosPage />} />
                  <Route path="/contabilidad/plan" element={<PlanContablePage />} />
                  <Route path="/contabilidad/cierres" element={<CierresPage />} />
                  <Route path="/impuestos" element={<ImpuestosRuta />} />
                  <Route path="/impuestos/sociedades" element={<Sociedades200Page />} />
                  <Route path="/impuestos/cuentas-anuales" element={<CuentasAnualesPage />} />
                  <Route path="/impuestos/:modeloId" element={<ImpuestoDetalleRuta />} />
                  <Route path="/lector" element={<LectorPage />} />
                  <Route path="/admin/usuarios" element={<AdminUsuariosPage />} />
                  <Route path="/admin/empresas" element={<AdminEmpresasPage />} />
                  <Route path="*" element={<Navigate to="/" replace />} />
                </Routes>
              </Suspense>
            }
          />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
