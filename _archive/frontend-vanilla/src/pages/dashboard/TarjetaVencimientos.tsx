import React, { memo, useState } from 'react';
import { FiltroTiempo, LadoVencimientos, ResumenVencimientos } from '../../app/dashboardApi';
import { eur, InfoTip, Skeleton } from '../../app/ui';

/**
 * Tarjeta de vencimientos (componente "tonto"). Lo controla el padre via
 * onFiltroTiempoChange. Colores: VERDE = a cobrar (entra dinero), ROJO = a pagar
 * (sale dinero); el resultado usa verde si hay superavit, rojo si hay deficit.
 */
type Vista = 'porMes' | 'porRango';

export interface TarjetaVencimientosProps {
  resumen: ResumenVencimientos | null;
  filtroTiempo: FiltroTiempo;
  onFiltroTiempoChange: (f: FiltroTiempo) => void;
  isLoading: boolean;
}

const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

/** Subtarjeta de un lado (a cobrar / a pagar) con desglose atrasado/futuro + chips por mes. */
function SubLado(props: { titulo: string; lado: LadoVencimientos; bg: string; color: string }): React.ReactElement {
  const { lado } = props;
  return (
    <div style={{ flex: 1, minWidth: 165, background: props.bg, borderRadius: 8, padding: 12 }}>
      <div style={{ fontSize: 13, color: '#556' }}>{props.titulo}</div>
      <div style={{ fontSize: 23, fontWeight: 800, color: props.color }}>{eur(lado.total)}</div>
      <div style={{ fontSize: 12, color: '#b3261e' }}>Atrasado: {eur(lado.atrasado)}</div>
      <div style={{ fontSize: 12, color: '#556' }}>Pendiente (no vencido): {eur(lado.futuro)}</div>
      {lado.porMes.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 8 }}>
          {lado.porMes.slice(0, 4).map((m) => (
            <span key={m.mes} style={{ fontSize: 11, background: '#fff', border: '1px solid #e3e8ef', borderRadius: 10, padding: '1px 7px', color: '#556' }}>
              {m.mes}: {eur(m.importe)}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export const TarjetaVencimientos = memo(function TarjetaVencimientos(props: TarjetaVencimientosProps): React.ReactElement {
  const { filtroTiempo: ft, onFiltroTiempoChange } = props;
  const [vista, setVista] = useState<Vista>(ft.fromDate || ft.toDate ? 'porRango' : 'porMes');

  const sel: React.CSSProperties = { padding: 4, borderRadius: 6, border: '1px solid #ccd', fontSize: 12, marginLeft: 4 };
  const anoActual = new Date().getFullYear();
  const tabBtn = (activa: boolean): React.CSSProperties => ({
    padding: '4px 12px',
    borderRadius: 12,
    border: activa ? 'none' : '1px solid #ccd',
    background: activa ? '#1a56b0' : '#fff',
    color: activa ? '#fff' : '#445',
    fontSize: 12,
    cursor: 'pointer',
    marginRight: 4,
  });

  return (
    <div style={{ background: '#fff', border: '1px solid #e3e8ef', borderRadius: 10, padding: 16, flex: 1, minWidth: 320 }}>
      {/* Cabecera + selector de vista */}
      <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
        <b style={{ fontSize: 14 }}>Vencimientos</b>
        <div style={{ marginLeft: 'auto' }}>
          <button style={tabBtn(vista === 'porMes')} onClick={() => { setVista('porMes'); onFiltroTiempoChange({ year: ft.year, month: ft.month ?? new Date().getMonth() + 1 }); }}>
            Por mes
          </button>
          <button style={tabBtn(vista === 'porRango')} onClick={() => { setVista('porRango'); onFiltroTiempoChange({ year: ft.year }); }}>
            Por rango
          </button>
        </div>
      </div>

      {/* Controles segun la vista */}
      <div style={{ marginBottom: 10 }}>
        {vista === 'porMes' ? (
          <>
            <label style={{ fontSize: 12, color: '#445' }}>
              Año
              <select style={sel} value={ft.year} onChange={(e) => onFiltroTiempoChange({ ...ft, year: Number(e.target.value) })}>
                {[anoActual - 2, anoActual - 1, anoActual, anoActual + 1].map((a) => <option key={a} value={a}>{a}</option>)}
              </select>
            </label>
            <label style={{ fontSize: 12, color: '#445', marginLeft: 10 }}>
              Mes
              <select style={sel} value={ft.month ?? ''} onChange={(e) => onFiltroTiempoChange({ year: ft.year, month: Number(e.target.value) })}>
                <option value="">(todo el año)</option>
                {MESES.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
              </select>
            </label>
          </>
        ) : (
          <>
            <label style={{ fontSize: 12, color: '#445' }}>
              Desde
              <input style={sel} type="date" value={ft.fromDate ?? ''} onChange={(e) => onFiltroTiempoChange({ year: ft.year, fromDate: e.target.value, toDate: ft.toDate })} />
            </label>
            <label style={{ fontSize: 12, color: '#445', marginLeft: 10 }}>
              Hasta
              <input style={sel} type="date" value={ft.toDate ?? ''} onChange={(e) => onFiltroTiempoChange({ year: ft.year, fromDate: ft.fromDate, toDate: e.target.value })} />
            </label>
          </>
        )}
      </div>

      {/* Banda: tiempo medio de cobro */}
      <div style={{ background: '#eef4ff', borderRadius: 8, padding: '8px 12px', fontSize: 13, color: '#1a56b0', fontWeight: 600, marginBottom: 12 }}>
        ⏱ Tiempo medio de cobro:{' '}
        {props.isLoading ? '…' : props.resumen?.tiempoMedioCobroDias != null ? `${props.resumen.tiempoMedioCobroDias} dias` : '—'}
        <InfoTip texto="Media de dias entre la fecha de emision y el ultimo cobro de las facturas ya cobradas. Si no hay facturas cobradas, se muestra '—'." />
        {!props.isLoading && props.resumen?.tiempoMedioCobroDias == null && (
          <span style={{ fontWeight: 400, color: '#778', marginLeft: 6 }}>(aun no hay facturas cobradas)</span>
        )}
      </div>

      {/* 3 subtarjetas */}
      {props.isLoading ? (
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          {[0, 1, 2].map((i) => <Skeleton key={i} alto={110} ancho={165} style={{ flex: 1, minWidth: 165 }} />)}
        </div>
      ) : !props.resumen ? (
        <div style={{ color: '#778', fontSize: 13, padding: 20, textAlign: 'center' }}>No hay datos de vencimientos para el periodo seleccionado.</div>
      ) : (
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <SubLado titulo="A cobrar" lado={props.resumen.aCobrar} bg="#e6f6ec" color="#0f7a3d" />
          <SubLado titulo="A pagar" lado={props.resumen.aPagar} bg="#fdeae8" color="#b3261e" />
          <div style={{ flex: 1, minWidth: 165, background: props.resumen.neto >= 0 ? '#e6f6ec' : '#fdeae8', borderRadius: 8, padding: 12 }}>
            <div style={{ fontSize: 13, color: '#556' }}>Resultado final</div>
            <div style={{ fontSize: 23, fontWeight: 800, color: props.resumen.neto >= 0 ? '#0f7a3d' : '#b3261e' }}>{eur(props.resumen.neto)}</div>
            <div style={{ fontSize: 12, color: '#556', marginTop: 4 }}>
              {props.resumen.neto >= 0 ? '✓ Superavit de cobros' : '⚠ Deficit de cobros'}
            </div>
            {/* mini-barra del balance cobrar vs pagar */}
            <div style={{ display: 'flex', height: 8, borderRadius: 4, overflow: 'hidden', marginTop: 8, background: '#eef1f5' }}>
              {(() => {
                const c = props.resumen.aCobrar.total;
                const p = props.resumen.aPagar.total;
                const tot = c + p || 1;
                return (
                  <>
                    <div style={{ width: `${(c / tot) * 100}%`, background: '#0f7a3d' }} />
                    <div style={{ width: `${(p / tot) * 100}%`, background: '#b3261e' }} />
                  </>
                );
              })()}
            </div>
          </div>
        </div>
      )}
    </div>
  );
});
