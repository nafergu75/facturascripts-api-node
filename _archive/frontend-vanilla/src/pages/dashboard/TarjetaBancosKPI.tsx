import React, { memo } from 'react';
import { eur, Skeleton } from '../../app/ui';

/**
 * Tarjeta KPI de bancos (componente "tonto": recibe datos ya preparados, no
 * llama a la API). Valor principal neutro; la variacion en verde si sube, rojo
 * si baja — el color comunica la direccion de la liquidez de un vistazo.
 */
export interface TarjetaBancosKPIProps {
  saldoTotal: number | null;
  numeroCuentas: number;
  variacionRespectoPeriodoAnterior?: number;
  isLoading: boolean;
}

export const TarjetaBancosKPI = memo(function TarjetaBancosKPI(props: TarjetaBancosKPIProps): React.ReactElement {
  const v = props.variacionRespectoPeriodoAnterior;
  const card: React.CSSProperties = { background: '#fff', border: '1px solid #e3e8ef', borderRadius: 10, padding: '16px 18px' };

  if (props.isLoading) {
    return (
      <div style={card}>
        <Skeleton alto={13} ancho="40%" style={{ marginBottom: 10 }} />
        <Skeleton alto={30} ancho="60%" style={{ marginBottom: 10 }} />
        <Skeleton alto={12} ancho="70%" />
      </div>
    );
  }

  return (
    <div style={card}>
      <div style={{ fontSize: 13, color: '#667' }}>Saldo en bancos</div>
      <div style={{ fontSize: 28, fontWeight: 800, color: '#16243a', margin: '2px 0 6px' }}>
        {props.saldoTotal == null ? '— sin datos' : eur(props.saldoTotal)}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12 }}>
        <span style={{ color: '#778' }}>
          {props.numeroCuentas} {props.numeroCuentas === 1 ? 'cuenta' : 'cuentas'}
        </span>
        {v !== undefined && (
          <span style={{ color: v >= 0 ? '#0f7a3d' : '#b3261e', fontWeight: 600 }}>
            {v >= 0 ? '▲' : '▼'} {eur(Math.abs(v))} vs periodo anterior
          </span>
        )}
      </div>
    </div>
  );
});
