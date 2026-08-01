import React, { useState } from 'react';
import { useApp } from '../app/AppLayout';
import { useCarga } from '../app/hooks';
import { btnPrimario, Cargando, ErrorBanner, EstadoVacio, td, th, TituloPagina } from '../app/ui';

/** Empresas de la plataforma (solo ADMIN GLOBAL). Cada empresa = una instancia FS. */
export function AdminEmpresasPage(): React.ReactElement {
  const { api, sesion } = useApp();
  const [alta, setAlta] = useState(false);
  const [nueva, setNueva] = useState({ nombre: '', codigo: '', fsBaseUrl: 'http://localhost:8000/api/3', fsApiKey: '' });
  const { datos, cargando, error, recargar, setError } = useCarga(() => api.getEmpresasAdmin(), [api, sesion.companyId]);

  const crear = async (): Promise<void> => {
    try {
      await api.crearEmpresaAdmin(nueva);
      setAlta(false);
      await recargar();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al crear la empresa');
    }
  };

  const input: React.CSSProperties = { padding: 6, borderRadius: 6, border: '1px solid #ccd', fontSize: 13, marginRight: 8, marginBottom: 6 };
  const esPermiso = (error ?? '').toLowerCase().includes('permiso') || (error ?? '').includes('403') || (error ?? '').toLowerCase().includes('admin');

  return (
    <div>
      <TituloPagina acciones={<button style={btnPrimario} onClick={() => setAlta(!alta)}>{alta ? 'Cancelar' : '+ Nueva empresa'}</button>}>
        Empresas (plataforma)
      </TituloPagina>
      <p style={{ fontSize: 12, color: '#667' }}>Cada empresa apunta a su propia instancia de FacturaScripts; la API Key se guarda cifrada (AES-256-GCM).</p>

      {alta && (
        <div style={{ background: '#fff', border: '1px solid #e3e8ef', borderRadius: 8, padding: 12, marginBottom: 12 }}>
          <input style={input} placeholder="Nombre *" value={nueva.nombre} onChange={(e) => setNueva({ ...nueva, nombre: e.target.value })} />
          <input style={input} placeholder="Codigo corto (acceso) *" value={nueva.codigo} onChange={(e) => setNueva({ ...nueva, codigo: e.target.value })} />
          <input style={{ ...input, width: 280 }} placeholder="URL API FacturaScripts *" value={nueva.fsBaseUrl} onChange={(e) => setNueva({ ...nueva, fsBaseUrl: e.target.value })} />
          <input style={{ ...input, width: 280 }} placeholder="FS_API_KEY *" value={nueva.fsApiKey} onChange={(e) => setNueva({ ...nueva, fsApiKey: e.target.value })} />
          <button style={btnPrimario} onClick={() => void crear()}>Crear empresa</button>
        </div>
      )}

      {error &&
        (esPermiso ? (
          <EstadoVacio mensaje="Esta seccion requiere ser ADMIN GLOBAL de la plataforma." />
        ) : (
          <ErrorBanner mensaje={error} />
        ))}

      {cargando ? (
        <Cargando />
      ) : (
        datos && (
          <div style={{ background: '#fff', borderRadius: 8, border: '1px solid #e3e8ef', overflow: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr><th style={th}>Codigo</th><th style={th}>Nombre</th><th style={th}>FacturaScripts</th><th style={th}>Activa</th></tr>
              </thead>
              <tbody>
                {datos.map((e, i) => (
                  <tr key={i}>
                    <td style={{ ...td, fontWeight: 700 }}>{String(e.codigo ?? '')}</td>
                    <td style={td}>{String(e.nombre ?? '')}</td>
                    <td style={{ ...td, fontFamily: 'monospace', fontSize: 12 }}>{String(e.fsBaseUrl ?? '')}</td>
                    <td style={td}>{e.activa ? '✓' : '✗'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}
    </div>
  );
}
