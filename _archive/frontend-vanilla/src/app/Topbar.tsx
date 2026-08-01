import React from 'react';
import { EmpresaSesion } from './types';

/**
 * Cabecera superior: empresa activa + selector multiempresa + usuario + logout.
 */
export interface TopbarProps {
  empresas: EmpresaSesion[];
  companyId: string;
  usuarioEmail: string;
  /** Titulo de la seccion actual (breadcrumb simple, claridad de navegacion). */
  tituloSeccion?: string;
  onCambiarEmpresa: (companyId: string) => void;
  onLogout: () => void;
}

export function Topbar(props: TopbarProps): React.ReactElement {
  const empresa = props.empresas.find((e) => e.companyId === props.companyId);
  return (
    <header
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        padding: '10px 20px',
        borderBottom: '1px solid #e3e8ef',
        background: '#fff',
        position: 'sticky',
        top: 0,
        zIndex: 10,
      }}
    >
      <div style={{ fontWeight: 700, fontSize: 15 }}>{empresa?.nombre ?? 'Sin empresa'}</div>
      {props.tituloSeccion && <div style={{ color: '#667', fontSize: 13 }}>/ {props.tituloSeccion}</div>}

      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12 }}>
        <label style={{ fontSize: 13, color: '#445' }}>
          Empresa{' '}
          <select
            value={props.companyId}
            onChange={(e) => props.onCambiarEmpresa(e.target.value)}
            style={{ padding: '4px 6px', borderRadius: 6, border: '1px solid #ccd' }}
          >
            {props.empresas.map((e) => (
              <option key={e.companyId} value={e.companyId}>
                {e.codigo ? `${e.codigo} — ` : ''}
                {e.nombre}
              </option>
            ))}
          </select>
        </label>
        <span title={props.usuarioEmail} style={{ fontSize: 13, color: '#445' }}>
          👤 {props.usuarioEmail}
        </span>
        <button
          onClick={props.onLogout}
          style={{ padding: '5px 12px', borderRadius: 6, border: '1px solid #ccd', background: '#fff', cursor: 'pointer', fontSize: 13 }}
        >
          Salir
        </button>
      </div>
    </header>
  );
}
