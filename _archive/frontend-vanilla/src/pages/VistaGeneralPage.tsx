import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../app/AppLayout';
import { useCarga } from '../app/hooks';
import { btnPrimario, ErrorBanner, SkeletonBloque, TituloPagina } from '../app/ui';
import {
  FiltroTiempo,
  getIngresosGastosPorMes,
  getResumenFinanciero,
  getSaldoBancosKpi,
  getSerieBancos,
  getVencimientos,
  PeriodoBasico,
  PuntoSerieBanco,
  ResumenFinanciero,
  ResumenVencimientos,
  SaldoBancosKpi,
} from '../app/dashboardApi';
import { Waterfall } from '../app/charts';
import { TarjetasResumen } from './dashboard/TarjetasResumen';
import { LiquidezYVencimientos } from './dashboard/LiquidezYVencimientos';
import { GraficoIngresosGastos } from './dashboard/GraficoIngresosGastos';
import { AnalisisIngresos, DetalleGastos } from './dashboard/AnalisisBloques';

/**
 * "Vista general" — dashboard financiero. VistaGeneralPage es el unico que
 * llama a la API; los componentes de bloque son "tontos" (reciben datos).
 * Estructura: 1) tarjetas resumen, 2) del ingreso al resultado (waterfall),
 * 3) liquidez y vencimientos, 4) ingresos/gastos por mes, 5) analisis.
 */
type PeriodoRapido = 'mes' | 'trimestre' | 'ano';

function rangoDe(periodo: PeriodoRapido): { desde: string; hasta: string; etiqueta: string } {
  const hoy = new Date();
  const y = hoy.getFullYear();
  const m = hoy.getMonth();
  const f = (d: Date): string => d.toISOString().slice(0, 10);
  if (periodo === 'mes') return { desde: f(new Date(y, m, 1)), hasta: f(new Date(y, m + 1, 0)), etiqueta: 'este mes' };
  if (periodo === 'trimestre') {
    const t = Math.floor(m / 3) * 3;
    return { desde: f(new Date(y, t, 1)), hasta: f(new Date(y, t + 3, 0)), etiqueta: 'este trimestre' };
  }
  return { desde: `${y}-01-01`, hasta: `${y}-12-31`, etiqueta: 'este año' };
}

export function VistaGeneralPage(): React.ReactElement {
  const { api, sesion } = useApp();
  const navigate = useNavigate();
  const co = sesion.companyId;

  // Periodo del RESUMEN superior (mes/trimestre/año)
  const [periodo, setPeriodo] = useState<PeriodoRapido>('ano');
  const rango = useMemo(() => rangoDe(periodo), [periodo]);
  const { datos: resumen, cargando, error } = useCarga<ResumenFinanciero>(() => getResumenFinanciero(api, rango), [api, co, rango.desde, rango.hasta]);

  // --- Bloque Liquidez y vencimientos: VistaGeneralPage carga, los hijos pintan ---
  const [periodoBasico, setPeriodoBasico] = useState<PeriodoBasico>('periodoCompleto');
  const [filtroTiempo, setFiltroTiempo] = useState<FiltroTiempo>({ year: new Date().getFullYear() });

  const { datos: kpi } = useCarga<SaldoBancosKpi>(() => getSaldoBancosKpi(api), [api, co]);
  const { datos: serie } = useCarga<PuntoSerieBanco[]>(() => getSerieBancos(api, periodoBasico), [api, co, periodoBasico]);
  const { datos: venc } = useCarga<ResumenVencimientos>(
    () => getVencimientos(api, filtroTiempo),
    [api, co, filtroTiempo.year, filtroTiempo.month, filtroTiempo.fromDate, filtroTiempo.toDate],
  );
  const liquidezCargando = !kpi && !serie && !venc; // skeleton solo en la 1a carga

  const chip = (id: PeriodoRapido, etiqueta: string): React.ReactElement => (
    <button
      key={id}
      onClick={() => setPeriodo(id)}
      style={{ padding: '6px 14px', borderRadius: 16, border: periodo === id ? 'none' : '1px solid #ccd', background: periodo === id ? '#1a56b0' : '#fff', color: periodo === id ? '#fff' : '#445', cursor: 'pointer', fontSize: 13, marginRight: 6 }}
    >
      {etiqueta}
    </button>
  );

  return (
    <div>
      <TituloPagina acciones={<div>{chip('mes', 'Este mes')}{chip('trimestre', 'Este trimestre')}{chip('ano', 'Este año')}</div>}>
        Vista general
      </TituloPagina>
      {error && <ErrorBanner mensaje={error} />}

      {/* 1 · Tarjetas de resumen */}
      {cargando || !resumen ? <SkeletonBloque alto={110} lineas={2} /> : <TarjetasResumen datos={resumen} etiquetaPeriodo={rango.etiqueta} />}

      {/* 2 · Del ingreso al resultado (waterfall) */}
      {resumen && (resumen.ingresos > 0 || resumen.gastos > 0) && (
        <div style={{ background: '#fff', border: '1px solid #e3e8ef', borderRadius: 10, padding: 16, marginBottom: 16, maxWidth: 560 }}>
          <b style={{ fontSize: 14 }}>Del ingreso al resultado ({rango.etiqueta})</b>
          <Waterfall ingresos={resumen.ingresos} gastos={resumen.gastos} />
        </div>
      )}

      {/* 3 · Liquidez y vencimientos (bancos + vencimientos) */}
      <LiquidezYVencimientos
        saldoBancosKpi={kpi}
        puntosSerieBanco={serie}
        resumenVencimientos={venc}
        filtroTiempo={filtroTiempo}
        periodoBasico={periodoBasico}
        onFiltroTiempoChange={setFiltroTiempo}
        onPeriodoBasicoChange={setPeriodoBasico}
        isLoading={liquidezCargando}
      />

      {/* 4 · Ingresos y gastos por mes */}
      <GraficoIngresosGastos api={api} companyId={co} />

      {/* 5 · Analisis de ingresos / detalle de gastos */}
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 16 }}>
        <AnalisisIngresos api={api} companyId={co} />
        <DetalleGastos api={api} companyId={co} />
      </div>

      {/* CTA a informes */}
      <div style={{ background: 'linear-gradient(120deg, #16243a, #1a56b0)', color: '#fff', borderRadius: 12, padding: '20px 24px', display: 'flex', alignItems: 'center', gap: 20, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 260 }}>
          <div style={{ fontSize: 17, fontWeight: 800 }}>📑 Informes y exportaciones</div>
          <p style={{ fontSize: 13, color: '#cdd9ea', margin: '6px 0 0' }}>
            Libros de registro de IVA (formato AEAT), perdidas y ganancias, exportacion a A3 e informes para gestorias.
          </p>
        </div>
        <button style={{ ...btnPrimario, background: '#fff', color: '#1a56b0', fontWeight: 700, padding: '10px 22px' }} onClick={() => navigate('/informes')}>
          Ir a informes y exportaciones →
        </button>
      </div>
    </div>
  );
}
