import React from 'react';
import { ResumenFinanciero } from '../../app/dashboardApi';
import { eur } from '../../app/ui';

/** Fila superior de KPIs: ingresos, gastos, resultado (+IVA neto) y bancos. */
export interface TarjetasResumenProps {
  datos: ResumenFinanciero;
  etiquetaPeriodo: string; // 'este mes' | 'este trimestre' | 'este año'
}

function Tarjeta(props: { titulo: string; valor: string; color: string; sublineas: Array<[string, string]> }): React.ReactElement {
  return (
    <div style={{ background: '#fff', border: '1px solid #e3e8ef', borderRadius: 10, padding: '14px 18px', minWidth: 215, flex: 1 }}>
      <div style={{ fontSize: 13, color: '#667' }}>{props.titulo}</div>
      <div style={{ fontSize: 25, fontWeight: 800, color: props.color, margin: '2px 0 6px' }}>{props.valor}</div>
      {props.sublineas.map(([etiqueta, valor]) => (
        <div key={etiqueta} style={{ fontSize: 12, color: '#778', display: 'flex', justifyContent: 'space-between', gap: 8 }}>
          <span>{etiqueta}</span>
          <span style={{ fontWeight: 600, color: '#445' }}>{valor}</span>
        </div>
      ))}
    </div>
  );
}

export function TarjetasResumen({ datos, etiquetaPeriodo }: TarjetasResumenProps): React.ReactElement {
  const ivaNetoTxt = `${eur(Math.abs(datos.ivaNeto))} (${datos.ivaNeto >= 0 ? 'a ingresar' : 'a devolver'})`;
  return (
    <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 16 }}>
      <Tarjeta
        titulo={`Ingresos del periodo (${etiquetaPeriodo})`}
        valor={eur(datos.ingresos)}
        color="#0f7a3d"
        sublineas={[
          ['IVA ingresado (repercutido)', eur(datos.ivaRepercutido)],
          ['IRPF asociado', eur(datos.irpfIngresos)],
        ]}
      />
      <Tarjeta
        titulo={`Gastos del periodo (${etiquetaPeriodo})`}
        valor={eur(datos.gastos)}
        color="#b35c00"
        sublineas={[
          ['IVA soportado', eur(datos.ivaSoportado)],
          ['IRPF retenido', eur(datos.irpfGastos)],
        ]}
      />
      <Tarjeta
        titulo="Resultado (beneficio / perdida)"
        valor={eur(datos.resultado)}
        color={datos.resultado >= 0 ? '#0f7a3d' : '#b3261e'}
        sublineas={[['IVA neto', ivaNetoTxt]]}
      />
      <Tarjeta
        titulo="Saldo en bancos"
        valor={eur(datos.saldoBancos)}
        color="#1a56b0"
        sublineas={[['Cuentas bancarias', String(datos.numCuentas)]]}
      />
    </div>
  );
}
