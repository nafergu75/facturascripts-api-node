import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiClient } from '../app/apiClient';
import { useApp } from '../app/AppLayout';
import { btn, btnPrimario, TituloPagina } from '../app/ui';

/**
 * "Informes y exportaciones": bloques de descarga organizados por finalidad
 * (libros de IVA AEAT, informacion general, A3, gestorias) con selector global
 * de año/periodo arriba.
 *
 * Decision UX clave: los LIBROS DE IVA siempre descargan el AÑO COMPLETO aunque
 * el selector marque un trimestre o mes — la AEAT exige el libro integro del
 * ejercicio. El propio bloque lo avisa para que el usuario no crea que filtra.
 */

// --- Selector año/periodo ---
export interface SeleccionPeriodo {
  year: number;
  /** '0A' (todo el año) | '1T'..'4T' | '01'..'12' */
  periodo: string;
}

const PERIODOS: Array<{ valor: string; etiqueta: string }> = [
  { valor: '0A', etiqueta: 'Todo el año' },
  ...['1', '2', '3', '4'].map((t) => ({ valor: `${t}T`, etiqueta: `Trimestre T${t}` })),
  ...['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'].map(
    (mes, i) => ({ valor: String(i + 1).padStart(2, '0'), etiqueta: mes }),
  ),
];

function SelectorAnoPeriodo(props: { sel: SeleccionPeriodo; onChange: (s: SeleccionPeriodo) => void }): React.ReactElement {
  const anoActual = new Date().getFullYear();
  const anos = [anoActual - 3, anoActual - 2, anoActual - 1, anoActual];
  const select: React.CSSProperties = { padding: 7, borderRadius: 6, border: '1px solid #ccd', fontSize: 13, marginRight: 10 };
  return (
    <div style={{ background: '#fff', border: '1px solid #e3e8ef', borderRadius: 8, padding: 12, marginBottom: 16 }}>
      <label style={{ fontSize: 13, color: '#445' }}>
        Año{' '}
        <select style={select} value={props.sel.year} onChange={(e) => props.onChange({ ...props.sel, year: Number(e.target.value) })}>
          {anos.map((a) => (
            <option key={a} value={a}>{a}</option>
          ))}
        </select>
      </label>
      <label style={{ fontSize: 13, color: '#445' }}>
        Periodo{' '}
        <select style={select} value={props.sel.periodo} onChange={(e) => props.onChange({ ...props.sel, periodo: e.target.value })}>
          {PERIODOS.map((p) => (
            <option key={p.valor} value={p.valor}>{p.etiqueta}</option>
          ))}
        </select>
      </label>
      <span style={{ fontSize: 12, color: '#99a' }}>El periodo aplica a P&G y gestoría; los libros de IVA siempre van por año completo.</span>
    </div>
  );
}

// --- Bloque generico ---
function Bloque(props: { titulo: string; children: React.ReactNode }): React.ReactElement {
  return (
    <div style={{ background: '#fff', border: '1px solid #e3e8ef', borderRadius: 10, padding: '16px 20px', marginBottom: 14 }}>
      <div style={{ fontWeight: 800, fontSize: 15, marginBottom: 6 }}>{props.titulo}</div>
      {props.children}
    </div>
  );
}
const texto: React.CSSProperties = { fontSize: 13, color: '#556', margin: '0 0 12px' };

/** Estado de una descarga para feedback (toast inline por bloque). */
type Toast = { tipo: 'ok' | 'error'; texto: string } | null;

function useDescarga(): { toast: Toast; lanzar: (accion: () => Promise<void>, nombre: string) => Promise<void> } {
  const [toast, setToast] = useState<Toast>(null);
  const lanzar = async (accion: () => Promise<void>, nombre: string): Promise<void> => {
    setToast(null);
    try {
      await accion();
      setToast({ tipo: 'ok', texto: `✓ ${nombre} descargado.` });
      setTimeout(() => setToast(null), 4000);
    } catch (e) {
      setToast({ tipo: 'error', texto: e instanceof Error ? e.message : 'Error en la descarga' });
    }
  };
  return { toast, lanzar };
}

function ToastInline({ toast }: { toast: Toast }): React.ReactElement | null {
  if (!toast) return null;
  const ok = toast.tipo === 'ok';
  return (
    <div style={{ marginTop: 10, fontSize: 13, color: ok ? '#0f7a3d' : '#a00', background: ok ? '#e6f6ec' : '#ffe0e0', padding: 8, borderRadius: 6 }}>
      {toast.texto}
    </div>
  );
}

// --- Bloques concretos ---

export function LibrosIvaBlock({ api, year }: { api: ApiClient; year: number }): React.ReactElement {
  const { toast, lanzar } = useDescarga();
  return (
    <Bloque titulo="📘 Libros de registro de IVA">
      <p style={texto}>
        Descarga los libros de registro de IVA de tus ingresos y de tus gastos en el formato que pide la Agencia
        Tributaria. Se generan automaticamente a partir de las facturas que registras. <b>Esta exportacion descarga
        siempre el año completo ({year})</b>: usa el selector de año de arriba para cambiarlo.
      </p>
      <button style={btnPrimario} onClick={() => void lanzar(() => api.downloadLibroIvaIngresos(year), 'Libro de IVA de ingresos')}>
        ⬇ Registro de IVA de ingresos
      </button>
      <button style={btn} onClick={() => void lanzar(() => api.downloadLibroIvaGastos(year), 'Libro de IVA de gastos')}>
        ⬇ Registro de IVA de gastos y activos
      </button>
      <ToastInline toast={toast} />
    </Bloque>
  );
}

export function InformacionGeneralBlock({ api, sel }: { api: ApiClient; sel: SeleccionPeriodo }): React.ReactElement {
  const { toast, lanzar } = useDescarga();
  return (
    <Bloque titulo="📊 Informacion general">
      <p style={texto}>Informes genericos del negocio para el año/periodo seleccionado arriba.</p>
      <button style={btnPrimario} onClick={() => void lanzar(() => api.downloadInformePyG(sel.year, sel.periodo), 'Informe de perdidas y ganancias')}>
        ⬇ Informe de perdidas y ganancias
      </button>
      <ToastInline toast={toast} />
    </Bloque>
  );
}

export function ExportA3Block({ api, year }: { api: ApiClient; year: number }): React.ReactElement {
  const { toast, lanzar } = useDescarga();
  return (
    <Bloque titulo="🔁 Exportaciones a A3">
      <p style={texto}>
        ¿Tu gestoria trabaja con A3? Descarga el fichero <code>suenlace.dat</code> con los apuntes del ejercicio y
        subelo a A3 para integrar la contabilidad. Consulta el manual para los pasos de importacion.
      </p>
      {/* TODO: enlazar el manual real (PDF propio o pagina de ayuda) */}
      <a href="https://www.wolterskluwer.com/es-es" target="_blank" rel="noreferrer" style={{ ...btn, textDecoration: 'none', display: 'inline-block' }}>
        📖 Manual para exportar a A3
      </a>
      <button style={btnPrimario} onClick={() => void lanzar(() => api.downloadExportA3(year), 'suenlace.dat')}>
        ⬇ Exportar todo a A3
      </button>
      <ToastInline toast={toast} />
    </Bloque>
  );
}

export function InformesGestoriaBlock({ api }: { api: ApiClient }): React.ReactElement {
  const { toast, lanzar } = useDescarga();
  return (
    <Bloque titulo="🤝 Informes para gestorias">
      <p style={texto}>
        Informes pensados para que tu gestoria trabaje comoda: documentos subidos al lector que fueron rechazados o
        siguen pendientes de revision, con su detalle.
      </p>
      <button style={btnPrimario} onClick={() => void lanzar(() => api.downloadGastosRechazados(), 'Gastos rechazados')}>
        ⬇ Gastos rechazados
      </button>
      <ToastInline toast={toast} />
    </Bloque>
  );
}

// --- Pagina ---
export function InformesExportacionesPage(): React.ReactElement {
  const { api } = useApp();
  const navigate = useNavigate();
  const [sel, setSel] = useState<SeleccionPeriodo>({ year: new Date().getFullYear(), periodo: '0A' });

  return (
    <div style={{ maxWidth: 860 }}>
      <button style={{ ...btn, marginBottom: 10 }} onClick={() => navigate('/')}>← Vista general</button>
      <TituloPagina>Informes y exportaciones</TituloPagina>
      <SelectorAnoPeriodo sel={sel} onChange={setSel} />
      <LibrosIvaBlock api={api} year={sel.year} />
      <InformacionGeneralBlock api={api} sel={sel} />
      <ExportA3Block api={api} year={sel.year} />
      <InformesGestoriaBlock api={api} />
    </div>
  );
}
