import React from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { LoginPage } from './pages/Login';
import { HomePage } from './pages/Home';
import { ChatPage } from './pages/ChatPage';
import { LectorPage } from './pages/lector/LectorPage';
import { HelpPage } from './pages/help/HelpPage';
import { ApiTestPage } from './pages/api-test/ApiTestPage';
import { AppShell } from './components/layout/AppShell';
import { AccountingRoutes } from './routes/accounting.routes';
import { ReportsRoutes } from './routes/reports.routes';
import { TaxRoutes } from './routes/tax.routes';
import { SalesRoutes } from './routes/sales.routes';
import { TesoreriaRoutes } from './routes/tesoreria.routes';
import { AdminRoutes } from './routes/admin.routes';

function isAuthenticated(): boolean {
  return !!localStorage.getItem('jwt_token');
}

function RequireAuth({ children }: { children: React.ReactElement }): React.ReactElement {
  if (!isAuthenticated()) return <Navigate to="/login" replace />;
  return <AppShell>{children}</AppShell>;
}

/**
 * Como RequireAuth, pero deja pasar sin login cuando la URL trae ?demo=1.
 * Solo se usa en /lector: permite compartir un enlace de demo publica que no
 * necesita backend ni credenciales. Sin ese parametro, exige login igual que
 * cualquier otra ruta. La demo publica NO lleva AppShell (pagina standalone,
 * sin enlace a /ayuda que de todos modos exigiria login).
 */
function RequireAuthUnlessDemo({ children }: { children: React.ReactElement }): React.ReactElement {
  const esDemoPublica = new URLSearchParams(window.location.search).get('demo') === '1';
  if (esDemoPublica) return children;
  if (!isAuthenticated()) return <Navigate to="/login" replace />;
  return <AppShell>{children}</AppShell>;
}

export function App(): React.ReactElement {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/" element={<RequireAuth><HomePage /></RequireAuth>} />
      <Route path="/chat" element={<RequireAuth><ChatPage /></RequireAuth>} />
      <Route path="/ayuda" element={<RequireAuth><HelpPage /></RequireAuth>} />
      <Route path="/api-test" element={<RequireAuth><ApiTestPage /></RequireAuth>} />
      <Route path="/lector" element={<RequireAuthUnlessDemo><LectorPage /></RequireAuthUnlessDemo>} />
      <Route path="/accounting/*" element={<RequireAuth><AccountingRoutes /></RequireAuth>} />
      <Route path="/reports/*" element={<RequireAuth><ReportsRoutes /></RequireAuth>} />
      <Route path="/tax/*" element={<RequireAuth><TaxRoutes /></RequireAuth>} />
      <Route path="/sales/*" element={<RequireAuth><SalesRoutes /></RequireAuth>} />
      <Route path="/tesoreria/*" element={<RequireAuth><TesoreriaRoutes /></RequireAuth>} />
      <Route path="/admin/*" element={<RequireAuth><AdminRoutes /></RequireAuth>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
