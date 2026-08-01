import React, { memo } from 'react';
import { FiltroTiempo, PeriodoBasico, PuntoSerieBanco, ResumenVencimientos, SaldoBancosKpi } from '../../app/dashboardApi';
import { TarjetaBancosKPI } from './TarjetaBancosKPI';
import { TarjetaGraficoBancos } from './TarjetaGraficoBancos';
import { TarjetaVencimientos } from './TarjetaVencimientos';

/**
 * Bloque "Liquidez y vencimientos" (componente "tonto", controlado por
 * VistaGeneralPage). Agrupa bancos y vencimientos en UN MISMO bloque porque
 * juntos cuentan la liquidez: cuanto tengo + cuanto entra/sale y cuando.
 * Layout: en desktop, KPI bancos + grafico apilados a la izquierda y
 * vencimientos a la derecha; en pantallas estrechas, todo en columna.
 */
export interface LiquidezYVencimientosProps {
  saldoBancosKpi: SaldoBancosKpi | null;
  puntosSerieBanco: PuntoSerieBanco[] | null;
  resumenVencimientos: ResumenVencimientos | null;
  filtroTiempo: FiltroTiempo;
  periodoBasico: PeriodoBasico;
  onFiltroTiempoChange: (f: FiltroTiempo) => void;
  onPeriodoBasicoChange: (p: PeriodoBasico) => void;
  isLoading: boolean;
}

export const LiquidezYVencimientos = memo(function LiquidezYVencimientos(props: LiquidezYVencimientosProps): React.ReactElement {
  return (
    <section style={{ marginBottom: 16 }}>
      <h2 style={{ fontSize: 15, margin: '0 0 10px' }}>Liquidez y vencimientos</h2>
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        {/* Columna izquierda: KPI bancos + grafico */}
        <div style={{ flex: '1 1 360px', minWidth: 320, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <TarjetaBancosKPI
            saldoTotal={props.saldoBancosKpi?.saldoTotal ?? null}
            numeroCuentas={props.saldoBancosKpi?.numeroCuentas ?? 0}
            variacionRespectoPeriodoAnterior={props.saldoBancosKpi?.variacionRespectoPeriodoAnterior}
            isLoading={props.isLoading}
          />
          <TarjetaGraficoBancos
            serie={props.puntosSerieBanco}
            periodoBasico={props.periodoBasico}
            onPeriodoBasicoChange={props.onPeriodoBasicoChange}
            isLoading={props.isLoading}
          />
        </div>
        {/* Columna derecha: vencimientos */}
        <div style={{ flex: '1 1 360px', minWidth: 320 }}>
          <TarjetaVencimientos
            resumen={props.resumenVencimientos}
            filtroTiempo={props.filtroTiempo}
            onFiltroTiempoChange={props.onFiltroTiempoChange}
            isLoading={props.isLoading}
          />
        </div>
      </div>
    </section>
  );
});
