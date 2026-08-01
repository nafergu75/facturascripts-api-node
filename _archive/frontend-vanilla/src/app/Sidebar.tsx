import React, { useState } from 'react';
import { NavLink } from 'react-router-dom';

/**
 * Barra lateral fija con secciones y submenus desplegables (accordion).
 * UI con componentes propios + estilos inline, coherente con el resto del front.
 * TODO: extraer estilos a un tema global y sustituir emojis por una libreria
 * de iconos cuando se decida (lucide/heroicons).
 */
export interface OpcionMenu {
  etiqueta: string;
  ruta: string;
}

export interface SeccionMenu {
  id: string;
  etiqueta: string;
  icono: string; // emoji simple, sin dependencia de iconos
  /** Si no tiene opciones, la seccion ES un enlace directo (ej. Dashboard). */
  ruta?: string;
  opciones?: OpcionMenu[];
}

/** Menu de la aplicacion: refleja los modulos reales del backend. */
export const MENU: SeccionMenu[] = [
  { id: 'vista-general', etiqueta: 'Vista general', icono: '📊', ruta: '/' },
  {
    id: 'ventas',
    etiqueta: 'Ventas',
    icono: '🧾',
    opciones: [
      { etiqueta: 'Facturas', ruta: '/ventas/facturas' },
      { etiqueta: 'Clientes', ruta: '/ventas/clientes' },
      { etiqueta: 'Productos', ruta: '/ventas/productos' },
    ],
  },
  {
    id: 'compras',
    etiqueta: 'Compras / Gastos',
    icono: '🛒',
    opciones: [
      { etiqueta: 'Facturas de gasto', ruta: '/compras/facturas' },
      { etiqueta: 'Proveedores', ruta: '/compras/proveedores' },
    ],
  },
  {
    id: 'bancos',
    etiqueta: 'Bancos',
    icono: '🏦',
    opciones: [
      { etiqueta: 'Cuentas bancarias', ruta: '/bancos/cuentas' },
      { etiqueta: 'Extractos', ruta: '/bancos/extractos' },
      { etiqueta: 'Conciliacion', ruta: '/bancos/conciliacion' },
    ],
  },
  {
    id: 'contabilidad',
    etiqueta: 'Contabilidad',
    icono: '📚',
    opciones: [
      { etiqueta: 'Asientos', ruta: '/contabilidad/asientos' },
      { etiqueta: 'Plan contable', ruta: '/contabilidad/plan' },
      { etiqueta: 'Cierres', ruta: '/contabilidad/cierres' },
    ],
  },
  {
    id: 'impuestos',
    etiqueta: 'Impuestos',
    icono: '🏛️',
    opciones: [
      { etiqueta: 'Modelos AEAT', ruta: '/impuestos' },
      { etiqueta: 'Sociedades (200)', ruta: '/impuestos/sociedades' },
      { etiqueta: 'Cuentas anuales', ruta: '/impuestos/cuentas-anuales' },
    ],
  },
  { id: 'lector', etiqueta: 'Lector de facturas', icono: '📥', ruta: '/lector' },
  {
    id: 'admin',
    etiqueta: 'Administracion',
    icono: '⚙️',
    opciones: [
      { etiqueta: 'Usuarios', ruta: '/admin/usuarios' },
      { etiqueta: 'Empresas', ruta: '/admin/empresas' },
    ],
  },
];

const estilos = {
  aside: {
    width: 230,
    minWidth: 230,
    background: '#16243a',
    color: '#dbe4f0',
    height: '100vh',
    position: 'sticky' as const,
    top: 0,
    overflowY: 'auto' as const,
    fontSize: 14,
  },
  cabecera: { padding: '16px 14px', fontWeight: 800, fontSize: 16, color: '#fff', borderBottom: '1px solid #2a3b58' },
  seccion: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    width: '100%',
    padding: '10px 14px',
    background: 'none',
    border: 'none',
    color: '#dbe4f0',
    cursor: 'pointer',
    fontSize: 14,
    textAlign: 'left' as const,
  },
  flecha: (abierta: boolean): React.CSSProperties => ({
    marginLeft: 'auto',
    transition: 'transform .15s',
    transform: abierta ? 'rotate(90deg)' : 'none',
    fontSize: 11,
  }),
  enlace: (activo: boolean): React.CSSProperties => ({
    display: 'block',
    padding: '7px 14px 7px 40px',
    color: activo ? '#fff' : '#aab8cc',
    background: activo ? '#1a56b0' : 'transparent',
    textDecoration: 'none',
    borderRadius: 4,
    margin: '1px 6px',
    fontSize: 13,
  }),
};

export interface SidebarProps {
  secciones?: SeccionMenu[];
}

export function Sidebar({ secciones = MENU }: SidebarProps): React.ReactElement {
  // Secciones desplegadas (por defecto, todas las que tienen submenus cerradas
  // salvo Ventas, para orientar al usuario nuevo).
  const [abiertas, setAbiertas] = useState<Set<string>>(new Set(['ventas']));

  const alternar = (id: string): void => {
    setAbiertas((prev) => {
      const s = new Set(prev);
      if (s.has(id)) s.delete(id);
      else s.add(id);
      return s;
    });
  };

  return (
    <aside style={estilos.aside}>
      <div style={estilos.cabecera}>Conta API</div>
      <nav>
        {secciones.map((sec) =>
          sec.opciones ? (
            <div key={sec.id}>
              <button style={estilos.seccion} onClick={() => alternar(sec.id)} aria-expanded={abiertas.has(sec.id)}>
                <span>{sec.icono}</span> {sec.etiqueta}
                <span style={estilos.flecha(abiertas.has(sec.id))}>▶</span>
              </button>
              {abiertas.has(sec.id) &&
                sec.opciones.map((op) => (
                  <NavLink key={op.ruta} to={op.ruta} end style={({ isActive }) => estilos.enlace(isActive)}>
                    {op.etiqueta}
                  </NavLink>
                ))}
            </div>
          ) : (
            <NavLink key={sec.id} to={sec.ruta ?? '/'} end style={({ isActive }) => ({ ...estilos.seccion, textDecoration: 'none', background: isActive ? '#1a56b0' : 'transparent', color: isActive ? '#fff' : '#dbe4f0' })}>
              <span>{sec.icono}</span> {sec.etiqueta}
            </NavLink>
          ),
        )}
      </nav>
    </aside>
  );
}
