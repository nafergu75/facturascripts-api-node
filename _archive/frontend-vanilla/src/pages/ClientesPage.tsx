import React, { useState } from 'react';
import { useApp } from '../app/AppLayout';
import { useCarga } from '../app/hooks';
import { btn, btnPrimario, Cargando, ErrorBanner, EstadoVacio, td, th, TituloPagina } from '../app/ui';

/** Datos editables de un cliente (nombre/email/telefono; NIF y codigo son fijos). */
interface EdicionCliente {
  nombre: string;
  email: string;
  telefono: string;
}

/** Clientes: listado + busqueda en vivo + alta rapida (con telefono) + edicion en linea. */
export function ClientesPage(): React.ReactElement {
  const { api, sesion } = useApp();
  const [q, setQ] = useState('');
  const [alta, setAlta] = useState(false);
  const [nuevo, setNuevo] = useState({ nombre: '', cifnif: '', email: '', telefono: '' });
  // Edicion en linea: codcliente que se esta editando + valores en curso.
  const [editId, setEditId] = useState<string | null>(null);
  const [edit, setEdit] = useState<EdicionCliente>({ nombre: '', email: '', telefono: '' });

  const { datos, cargando, error, recargar, setError } = useCarga(
    () =>
      q.trim()
        ? api.buscarClientes(q, 50).then((r) => r.map((c) => ({ codcliente: c.id, nombre: c.nombre, cifnif: c.nif, email: c.email, telefono1: c.telefono })))
        : api.getClientes().then((p) => p.items),
    [api, sesion.companyId, q],
  );

  const crear = async (): Promise<void> => {
    if (!nuevo.nombre || !nuevo.cifnif) {
      setError('Nombre y NIF son obligatorios.');
      return;
    }
    try {
      await api.crearCliente(nuevo);
      setAlta(false);
      setNuevo({ nombre: '', cifnif: '', email: '', telefono: '' });
      await recargar();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al crear el cliente');
    }
  };

  const abrirEdicion = (c: Record<string, unknown>): void => {
    setEditId(String(c.codcliente ?? ''));
    setEdit({
      nombre: String(c.nombre ?? c.razonsocial ?? ''),
      email: String(c.email ?? ''),
      telefono: String(c.telefono1 ?? ''),
    });
  };

  const guardarEdicion = async (): Promise<void> => {
    if (!editId) return;
    try {
      await api.actualizarCliente(editId, edit);
      setEditId(null);
      await recargar();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al actualizar el cliente');
    }
  };

  const input: React.CSSProperties = { padding: 6, borderRadius: 6, border: '1px solid #ccd', fontSize: 13, marginRight: 8 };
  const inputCelda: React.CSSProperties = { padding: 4, borderRadius: 4, border: '1px solid #ccd', fontSize: 13, width: '95%' };
  const lista = (datos ?? []) as Array<Record<string, unknown>>;

  return (
    <div>
      <TituloPagina acciones={<button style={btnPrimario} onClick={() => setAlta(!alta)}>{alta ? 'Cancelar' : '+ Nuevo cliente'}</button>}>
        Clientes
      </TituloPagina>

      {alta && (
        <div style={{ background: '#fff', border: '1px solid #e3e8ef', borderRadius: 8, padding: 12, marginBottom: 12 }}>
          <input style={input} placeholder="Nombre / razon social *" value={nuevo.nombre} onChange={(e) => setNuevo({ ...nuevo, nombre: e.target.value })} />
          <input style={input} placeholder="NIF *" value={nuevo.cifnif} onChange={(e) => setNuevo({ ...nuevo, cifnif: e.target.value })} />
          <input style={input} placeholder="Email" value={nuevo.email} onChange={(e) => setNuevo({ ...nuevo, email: e.target.value })} />
          <input style={input} placeholder="Telefono" value={nuevo.telefono} onChange={(e) => setNuevo({ ...nuevo, telefono: e.target.value })} />
          <button style={btnPrimario} onClick={() => void crear()}>Guardar cliente</button>
        </div>
      )}

      <input style={{ ...input, width: 320, marginBottom: 12 }} placeholder="🔍 Buscar por nombre, NIF o email…" value={q} onChange={(e) => setQ(e.target.value)} />
      {error && <ErrorBanner mensaje={error} />}

      {cargando ? (
        <Cargando />
      ) : lista.length === 0 ? (
        <EstadoVacio mensaje={q ? `Sin resultados para "${q}".` : 'Aun no hay clientes.'} accion={{ etiqueta: '+ Crear cliente', onClick: () => setAlta(true) }} />
      ) : (
        <div style={{ background: '#fff', borderRadius: 8, border: '1px solid #e3e8ef', overflow: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={th}>Codigo</th>
                <th style={th}>Nombre</th>
                <th style={th}>NIF</th>
                <th style={th}>Email</th>
                <th style={th}>Telefono</th>
                <th style={th}></th>
              </tr>
            </thead>
            <tbody>
              {lista.map((c, i) => {
                const id = String(c.codcliente ?? '');
                const enEdicion = editId === id && id !== '';
                return (
                  <tr key={i}>
                    <td style={{ ...td, fontWeight: 700 }}>{id}</td>
                    {enEdicion ? (
                      <>
                        <td style={td}><input style={inputCelda} value={edit.nombre} onChange={(e) => setEdit({ ...edit, nombre: e.target.value })} /></td>
                        <td style={td}>{String(c.cifnif ?? '')}</td>
                        <td style={td}><input style={inputCelda} value={edit.email} onChange={(e) => setEdit({ ...edit, email: e.target.value })} /></td>
                        <td style={td}><input style={inputCelda} value={edit.telefono} onChange={(e) => setEdit({ ...edit, telefono: e.target.value })} /></td>
                        <td style={{ ...td, whiteSpace: 'nowrap' }}>
                          <button style={btnPrimario} onClick={() => void guardarEdicion()}>Guardar</button>
                          <button style={btn} onClick={() => setEditId(null)}>Cancelar</button>
                        </td>
                      </>
                    ) : (
                      <>
                        <td style={td}>{String(c.nombre ?? c.razonsocial ?? '')}</td>
                        <td style={td}>{String(c.cifnif ?? '')}</td>
                        <td style={td}>{String(c.email ?? '')}</td>
                        <td style={td}>{String(c.telefono1 ?? '') || <span style={{ color: '#aab' }}>—</span>}</td>
                        <td style={td}><button style={btn} onClick={() => abrirEdicion(c)} disabled={!id}>Editar</button></td>
                      </>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
