import React, { createContext, useContext, useMemo, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { ApiClient } from './apiClient';
import { Sidebar, MENU } from './Sidebar';
import { Topbar } from './Topbar';
import { Sesion } from './types';
import { ChatAssistant } from '../chatbot/ChatAssistant';

/**
 * Contexto de sesion + API disponible para todas las paginas:
 *   const { api, sesion } = useApp();
 */
interface AppContexto {
  api: ApiClient;
  sesion: Sesion;
  cambiarEmpresa: (companyId: string) => void;
  logout: () => void;
}

const Contexto = createContext<AppContexto | null>(null);

export function useApp(): AppContexto {
  const ctx = useContext(Contexto);
  if (!ctx) throw new Error('useApp debe usarse dentro de <AppLayout>.');
  return ctx;
}

/** Titulo de seccion derivado de la ruta (claridad de navegacion). */
function tituloDeRuta(pathname: string): string {
  if (pathname.startsWith('/informes')) return 'Vista general · Informes y exportaciones';
  for (const sec of MENU) {
    if (sec.ruta === pathname) return sec.etiqueta;
    const op = sec.opciones?.find((o) => pathname.startsWith(o.ruta));
    if (op) return `${sec.etiqueta} · ${op.etiqueta}`;
  }
  return '';
}

export interface AppLayoutProps {
  api: ApiClient;
  sesionInicial: Sesion;
  onLogout: () => void;
}

/** Layout principal: Sidebar fija + Topbar + contenido (Outlet del router). */
export function AppLayout(props: AppLayoutProps): React.ReactElement {
  const [sesion, setSesion] = useState<Sesion>(props.sesionInicial);
  const navigate = useNavigate();
  const location = useLocation();

  const ctx = useMemo<AppContexto>(
    () => ({
      api: props.api,
      sesion,
      cambiarEmpresa: (companyId) => {
        props.api.setSesion(sesion.token, companyId);
        setSesion((s) => ({ ...s, companyId }));
        navigate('/'); // al cambiar de empresa, volver al dashboard
      },
      logout: props.onLogout,
    }),
    [props.api, props.onLogout, sesion, navigate],
  );

  return (
    <Contexto.Provider value={ctx}>
      <div style={{ display: 'flex', minHeight: '100vh', fontFamily: 'system-ui, sans-serif', background: '#f5f7fa' }}>
        <Sidebar />
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <Topbar
            empresas={sesion.empresas}
            companyId={sesion.companyId}
            usuarioEmail={sesion.email}
            tituloSeccion={tituloDeRuta(location.pathname)}
            onCambiarEmpresa={ctx.cambiarEmpresa}
            onLogout={ctx.logout}
          />
          <main style={{ padding: 20, flex: 1 }}>
            <Outlet />
          </main>
        </div>
        <ChatAssistant />
      </div>
    </Contexto.Provider>
  );
}
