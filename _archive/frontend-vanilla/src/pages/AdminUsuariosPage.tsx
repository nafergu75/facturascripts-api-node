import React, { useState } from 'react';
import { useApp } from '../app/AppLayout';
import { useCarga } from '../app/hooks';
import { btn, btnPrimario, Cargando, ErrorBanner, EstadoVacio, td, th, TituloPagina } from '../app/ui';

/** Usuarios de la plataforma (solo ADMIN GLOBAL; otros roles veran el 403). */
export function AdminUsuariosPage(): React.ReactElement {
  const { api, sesion } = useApp();
  const [alta, setAlta] = useState(false);
  const [nuevo, setNuevo] = useState({ email: '', password: '' });
  const { datos, cargando, error, recargar, setError } = useCarga(() => api.getUsers(), [api, sesion.companyId]);

  const crear = async (): Promise<void> => {
    try {
      await api.crearUser(nuevo.email, nuevo.password);
      setAlta(false);
      setNuevo({ email: '', password: '' });
      await recargar();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al crear el usuario');
    }
  };

  const alternarActivo = async (u: Record<string, unknown>): Promise<void> => {
    try {
      await api.actualizarUser(String(u.id), { isActive: !(u.isActive as boolean) });
      await recargar();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error');
    }
  };

  const input: React.CSSProperties = { padding: 6, borderRadius: 6, border: '1px solid #ccd', fontSize: 13, marginRight: 8 };
  const esPermiso = (error ?? '').toLowerCase().includes('permiso') || (error ?? '').includes('403') || (error ?? '').toLowerCase().includes('admin');

  return (
    <div>
      <TituloPagina acciones={<button style={btnPrimario} onClick={() => setAlta(!alta)}>{alta ? 'Cancelar' : '+ Nuevo usuario'}</button>}>
        Usuarios (plataforma)
      </TituloPagina>

      {alta && (
        <div style={{ background: '#fff', border: '1px solid #e3e8ef', borderRadius: 8, padding: 12, marginBottom: 12 }}>
          <input style={{ ...input, width: 240 }} placeholder="email *" value={nuevo.email} onChange={(e) => setNuevo({ ...nuevo, email: e.target.value })} />
          <input style={input} type="password" placeholder="contrasena *" value={nuevo.password} onChange={(e) => setNuevo({ ...nuevo, password: e.target.value })} />
          <button style={btnPrimario} onClick={() => void crear()}>Crear</button>
          <p style={{ fontSize: 12, color: '#667', marginBottom: 0 }}>La asignacion a empresas con rol se hace en Administracion · Empresas (o via /admin).</p>
        </div>
      )}

      {error &&
        (esPermiso ? (
          <EstadoVacio mensaje="Esta seccion requiere ser ADMIN GLOBAL de la plataforma. Tu usuario solo administra sus empresas asignadas." />
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
                <tr><th style={th}>Email</th><th style={th}>Activo</th><th style={th}>Empresas</th><th style={th}>Alta</th><th style={th}></th></tr>
              </thead>
              <tbody>
                {datos.items.map((u, i) => (
                  <tr key={i}>
                    <td style={{ ...td, fontWeight: 600 }}>{String(u.email)}</td>
                    <td style={td}>{u.isActive ? '✓' : '✗ inactivo'}</td>
                    <td style={td}>{Array.isArray(u.companies) ? (u.companies as string[]).length : 0}</td>
                    <td style={td}>{String(u.createdAt ?? '').slice(0, 10)}</td>
                    <td style={td}>
                      <button style={btn} onClick={() => void alternarActivo(u)}>{u.isActive ? 'Desactivar' : 'Activar'}</button>
                    </td>
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
