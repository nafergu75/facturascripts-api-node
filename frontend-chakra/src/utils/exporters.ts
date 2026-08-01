/**
 * Utilidades de exportación — CSV, Excel (xlsx), PDF (print)
 */

import * as XLSX from 'xlsx';
import {
  BalanceSheetResponse,
  ProfitAndLossResponse,
  LedgerResponse,
  CustomerAnalysisResponse,
  MonthlyEvolutionResponse,
  IncomeReportData,
  ExpensesReportData,
  ResultReportData,
  VatReportData,
  RetentionReportData,
  TreasuryReportData,
} from '../api/types';

/**
 * Exportar array de objetos a CSV.
 *
 * Incluye BOM UTF-8 (﻿) para que Excel en Windows lo abra con codificación correcta.
 * Si no hay datos lanza un Error en lugar de usar window.alert() (no accesible).
 */
export function exportToCsv(
  filename: string,
  rows: any[],
  headers?: string[],
): void {
  if (rows.length === 0) {
    throw new Error('No hay datos para exportar');
  }

  const headerKeys = headers || Object.keys(rows[0]);

  const csvContent = [
    headerKeys.join(','),
    ...rows.map(row =>
      headerKeys
        .map(header => {
          const value = row[header];
          if (typeof value === 'string' && (value.includes(',') || value.includes('"') || value.includes('\n'))) {
            return `"${value.replace(/"/g, '""')}"`;
          }
          return value ?? '';
        })
        .join(','),
    ),
  ].join('\n');

  // BOM UTF-8: necesario para que Excel en Windows interprete tildes y ñ correctamente
  const BOM = '﻿';
  downloadFile(BOM + csvContent, filename, 'text/csv;charset=utf-8');
}

/**
 * Exportar Balance General a CSV
 */
export function exportBalanceToCsv(balance: BalanceSheetResponse): void {
  const rows: any[] = [
    { seccion: 'ACTIVO', subseccion: 'No Circulante', importe: balance.activo.noCirculante },
    { seccion: 'ACTIVO', subseccion: 'Circulante', importe: balance.activo.circulante },
    {
      seccion: 'TOTAL ACTIVO',
      importe: balance.activo.noCirculante + balance.activo.circulante
    },
    { seccion: 'PASIVO', subseccion: 'No Circulante', importe: balance.pasivo.noCirculante },
    { seccion: 'PASIVO', subseccion: 'Circulante', importe: balance.pasivo.circulante },
    {
      seccion: 'TOTAL PASIVO',
      importe: balance.pasivo.noCirculante + balance.pasivo.circulante
    },
    { seccion: 'TOTAL PATRIMONIO NETO', importe: balance.patrimonioNeto }
  ];

  exportToCsv(
    `balance_${balance.fecha}.csv`,
    rows,
    ['seccion', 'subseccion', 'importe']
  );
}

/**
 * Exportar PyG a CSV
 */
export function exportPyGToCsv(pyg: ProfitAndLossResponse): void {
  const rows: any[] = [
    { concepto: 'TOTAL INGRESOS', importe: pyg.ingresos },
    { concepto: 'TOTAL GASTOS', importe: pyg.gastos },
    { concepto: 'RESULTADO EXPLOTACIÓN', importe: pyg.resultadoExplotacion }
  ];

  exportToCsv(
    `pyg_${pyg.desde}_${pyg.hasta}.csv`,
    rows,
    ['concepto', 'importe']
  );
}

/**
 * Exportar Mayor a CSV
 */
export function exportLedgerToCsv(ledger: LedgerResponse): void {
  const rows = ledger.movimientos.map(mov => ({
    fecha: mov.fecha,
    referencia: mov.referencia,
    debe: mov.debe,
    haber: mov.haber
  }));

  // Agregar encabezado y resumen
  const withSummary = [
    { cuenta: ledger.cuenta },
    ...rows,
    {
      fecha: '',
      referencia: 'Saldo Final',
      debe: 0,
      haber: ledger.saldoFinal
    }
  ];

  exportToCsv(
    `mayor_${ledger.cuenta}_${new Date().toISOString().split('T')[0]}.csv`,
    withSummary,
    ['cuenta', 'fecha', 'referencia', 'debe', 'haber']
  );
}

/**
 * Exportar Análisis por Cliente a CSV
 */
export function exportCustomerAnalysisToCsv(analysis: CustomerAnalysisResponse): void {
  const rows = analysis.clientes.map(cliente => ({
    cliente: cliente.nombre,
    totalFacturado: cliente.totalFacturado,
    saldoPendiente: cliente.saldoPendiente
  }));

  // Agregar total
  rows.push({
    cliente: 'TOTAL',
    totalFacturado: rows.reduce((sum, r) => sum + r.totalFacturado, 0),
    saldoPendiente: rows.reduce((sum, r) => sum + r.saldoPendiente, 0)
  });

  exportToCsv(
    `analisis_clientes_${new Date().toISOString().split('T')[0]}.csv`,
    rows,
    ['cliente', 'totalFacturado', 'saldoPendiente']
  );
}

/**
 * Exportar Evolución Mensual a CSV
 */
export function exportMonthlyEvolutionToCsv(evolution: MonthlyEvolutionResponse): void {
  const meses = Object.keys(evolution.meses).sort();

  const rows = meses.map(mes => ({
    mes: `${evolution.year}-${mes}`,
    ingresos: evolution.meses[mes].ingresos,
    gastos: evolution.meses[mes].gastos,
    beneficio: evolution.meses[mes].beneficio
  }));

  // Agregar totales
  rows.push({
    mes: 'TOTAL',
    ingresos: rows.reduce((sum, r) => sum + r.ingresos, 0),
    gastos: rows.reduce((sum, r) => sum + r.gastos, 0),
    beneficio: rows.reduce((sum, r) => sum + r.beneficio, 0)
  });

  exportToCsv(
    `evolucion_mensual_${new Date().toISOString().split('T')[0]}.csv`,
    rows,
    ['mes', 'ingresos', 'gastos', 'beneficio']
  );
}

/**
 * Descargar archivo de texto
 */
function downloadFile(content: string, filename: string, type: string): void {
  const blob = new Blob([content], { type });
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  window.URL.revokeObjectURL(url);
}

// ─── helpers internos ────────────────────────────────────────────────────────

const MONTH_SHORT = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
function mlabel(year: number, month: number): string {
  return `${MONTH_SHORT[month - 1]} ${year}`;
}

function downloadXlsx(wb: XLSX.WorkBook, filename: string): void {
  const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Abre una nueva ventana con el HTML del informe y dispara window.print().
 * El usuario elige "Guardar como PDF" en el diálogo de impresión del navegador.
 */
function printHtml(title: string, periodStr: string, summaryLines: [string, string][], tableHead: string[], tableRows: string[][]): void {
  const thHtml = tableHead.map(h => `<th>${h}</th>`).join('');
  const tdHtml = tableRows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('');
  const sumHtml = summaryLines.map(([k, v]) => `<tr><td class="k">${k}</td><td class="v">${v}</td></tr>`).join('');

  const html = `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><title>${title}</title>
<style>
  body{font-family:Arial,sans-serif;font-size:12px;color:#333;margin:20px}
  h1{font-size:16px;margin:0 0 4px}
  .period{font-size:11px;color:#666;margin-bottom:14px}
  .summary{background:#f4f6f9;border-radius:4px;padding:10px;margin-bottom:18px;display:inline-block;min-width:260px}
  .summary table{border-collapse:collapse}
  .summary td{padding:3px 8px}
  .summary .k{color:#555}
  .summary .v{font-weight:bold;text-align:right}
  table.main{width:100%;border-collapse:collapse}
  table.main th{background:#2b6cb0;color:#fff;padding:6px 8px;text-align:left;font-size:11px}
  table.main td{padding:5px 8px;border-bottom:1px solid #e2e8f0;font-size:11px}
  table.main tr:nth-child(even){background:#f7fafc}
  @media print{body{margin:0}}
</style></head><body>
<h1>${title}</h1>
<div class="period">Periodo: ${periodStr} · Generado: ${new Date().toLocaleDateString('es-ES')}</div>
<div class="summary"><table>${sumHtml}</table></div>
<table class="main"><thead><tr>${thHtml}</tr></thead><tbody>${tdHtml}</tbody></table>
</body></html>`;

  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const win = window.open(url, '_blank');
  if (win) {
    win.addEventListener('load', () => {
      setTimeout(() => { win.print(); setTimeout(() => URL.revokeObjectURL(url), 1500); }, 400);
    });
  } else {
    URL.revokeObjectURL(url);
    throw new Error(
      'El navegador bloqueó la ventana emergente. Permite ventanas emergentes para este sitio y vuelve a intentarlo.',
    );
  }
}

function fmt(n: number): string {
  return n.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
}

// ─── Ingresos ────────────────────────────────────────────────────────────────

export function exportIncomeToCsv(data: IncomeReportData): void {
  const rows = data.byMonth.map(m => ({
    Mes: mlabel(m.year, m.month),
    'Importe Base (€)': m.amount,
  }));
  rows.push({ Mes: 'TOTAL', 'Importe Base (€)': data.summary.totalIncome });
  exportToCsv(`ingresos_${data.period.from}_${data.period.to}.csv`, rows, ['Mes', 'Importe Base (€)']);
}

export function exportIncomeToExcel(data: IncomeReportData): void {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(
    data.byMonth.map(m => ({ Mes: mlabel(m.year, m.month), 'Base (€)': m.amount }))
  );
  XLSX.utils.book_append_sheet(wb, ws, 'Por Mes');
  downloadXlsx(wb, `ingresos_${data.period.from}_${data.period.to}.xlsx`);
}

export function exportIncomeToPdf(data: IncomeReportData): void {
  const rows = data.byMonth.map(m => [mlabel(m.year, m.month), fmt(m.amount)]);
  rows.push(['TOTAL', fmt(data.summary.totalIncome)]);
  printHtml(
    'Informe de Ingresos',
    `${data.period.from} — ${data.period.to}`,
    [['Total Ingresos (Base)', fmt(data.summary.totalIncome)]],
    ['Mes', 'Importe Base'],
    rows,
  );
}

// ─── Gastos ──────────────────────────────────────────────────────────────────

export function exportExpensesToCsv(data: ExpensesReportData): void {
  const rows = data.byMonth.map(m => ({
    Mes: mlabel(m.year, m.month),
    'Importe Base (€)': m.amount,
  }));
  rows.push({ Mes: 'TOTAL', 'Importe Base (€)': data.summary.totalExpenses });
  exportToCsv(`gastos_${data.period.from}_${data.period.to}.csv`, rows, ['Mes', 'Importe Base (€)']);
}

export function exportExpensesToExcel(data: ExpensesReportData): void {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(
    data.byMonth.map(m => ({ Mes: mlabel(m.year, m.month), 'Base (€)': m.amount }))
  );
  XLSX.utils.book_append_sheet(wb, ws, 'Por Mes');
  downloadXlsx(wb, `gastos_${data.period.from}_${data.period.to}.xlsx`);
}

export function exportExpensesToPdf(data: ExpensesReportData): void {
  const rows = data.byMonth.map(m => [mlabel(m.year, m.month), fmt(m.amount)]);
  rows.push(['TOTAL', fmt(data.summary.totalExpenses)]);
  printHtml(
    'Informe de Gastos',
    `${data.period.from} — ${data.period.to}`,
    [['Total Gastos (Base)', fmt(data.summary.totalExpenses)]],
    ['Mes', 'Importe Base'],
    rows,
  );
}

// ─── Resultado ───────────────────────────────────────────────────────────────

export function exportResultToCsv(data: ResultReportData): void {
  const rows = data.byMonth.map(m => ({
    Mes: mlabel(m.year, m.month),
    'Ingresos (€)': m.income,
    'Gastos (€)': m.expenses,
    'Resultado (€)': m.result,
  }));
  exportToCsv(`resultado_${data.period.from}_${data.period.to}.csv`, rows, ['Mes', 'Ingresos (€)', 'Gastos (€)', 'Resultado (€)']);
}

export function exportResultToExcel(data: ResultReportData): void {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(
    data.byMonth.map(m => ({
      Mes: mlabel(m.year, m.month),
      'Ingresos (€)': m.income,
      'Gastos (€)': m.expenses,
      'Resultado (€)': m.result,
    }))
  );
  XLSX.utils.book_append_sheet(wb, ws, 'Resultado');
  downloadXlsx(wb, `resultado_${data.period.from}_${data.period.to}.xlsx`);
}

export function exportResultToPdf(data: ResultReportData): void {
  const rows = data.byMonth.map(m => [mlabel(m.year, m.month), fmt(m.income), fmt(m.expenses), fmt(m.result)]);
  printHtml(
    'Informe de Resultado',
    `${data.period.from} — ${data.period.to}`,
    [
      ['Total Ingresos', fmt(data.summary.totalIncome)],
      ['Total Gastos', fmt(data.summary.totalExpenses)],
      ['Resultado', fmt(data.summary.result)],
    ],
    ['Mes', 'Ingresos', 'Gastos', 'Resultado'],
    rows,
  );
}

// ─── IVA ─────────────────────────────────────────────────────────────────────

export function exportVatToCsv(data: VatReportData): void {
  const rows = data.byMonth.map(m => ({
    Mes: mlabel(m.year, m.month),
    'IVA Rep. (€)': m.vatOutput,
    'IVA Sop. (€)': m.vatInput,
    'IVA a Pagar (€)': m.vatPayable,
  }));
  exportToCsv(`iva_${data.period.from}_${data.period.to}.csv`, rows, ['Mes', 'IVA Rep. (€)', 'IVA Sop. (€)', 'IVA a Pagar (€)']);
}

export function exportVatToExcel(data: VatReportData): void {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(
    data.byMonth.map(m => ({
      Mes: mlabel(m.year, m.month),
      'IVA Repercutido (€)': m.vatOutput,
      'IVA Soportado (€)': m.vatInput,
      'IVA a Pagar (€)': m.vatPayable,
    }))
  );
  XLSX.utils.book_append_sheet(wb, ws, 'IVA');
  downloadXlsx(wb, `iva_${data.period.from}_${data.period.to}.xlsx`);
}

export function exportVatToPdf(data: VatReportData): void {
  const rows = data.byMonth.map(m => [mlabel(m.year, m.month), fmt(m.vatOutput), fmt(m.vatInput), fmt(m.vatPayable)]);
  printHtml(
    'Informe de IVA',
    `${data.period.from} — ${data.period.to}`,
    [
      ['IVA Repercutido', fmt(data.summary.vatOutput)],
      ['IVA Soportado', fmt(data.summary.vatInput)],
      ['IVA a Pagar', fmt(data.summary.vatPayable)],
    ],
    ['Mes', 'IVA Repercutido', 'IVA Soportado', 'IVA a Pagar'],
    rows,
  );
}

// ─── Retenciones ─────────────────────────────────────────────────────────────

export function exportRetentionsToCsv(data: RetentionReportData): void {
  const rows = data.byProvider.map(p => ({
    NIF: p.nif,
    Nombre: p.nombre,
    Tipo: p.tipo,
    'Base (€)': p.base,
    'Retención (€)': p.retencion,
  }));
  exportToCsv(`retenciones_${data.period.from}_${data.period.to}.csv`, rows, ['NIF', 'Nombre', 'Tipo', 'Base (€)', 'Retención (€)']);
}

export function exportRetentionsToExcel(data: RetentionReportData): void {
  const wb = XLSX.utils.book_new();
  const wsByMonth = XLSX.utils.json_to_sheet(
    data.byMonth.map(m => ({ Mes: mlabel(m.year, m.month), 'Retención (€)': m.amount }))
  );
  XLSX.utils.book_append_sheet(wb, wsByMonth, 'Por Mes');
  const wsByProv = XLSX.utils.json_to_sheet(
    data.byProvider.map(p => ({
      NIF: p.nif,
      Nombre: p.nombre,
      Tipo: p.tipo,
      'Base (€)': p.base,
      'Retención (€)': p.retencion,
    }))
  );
  XLSX.utils.book_append_sheet(wb, wsByProv, 'Por Proveedor');
  downloadXlsx(wb, `retenciones_${data.period.from}_${data.period.to}.xlsx`);
}

export function exportRetentionsToPdf(data: RetentionReportData): void {
  const rows = data.byProvider.map(p => [p.nif, p.nombre, p.tipo, fmt(p.base), fmt(p.retencion)]);
  printHtml(
    'Informe de Retenciones IRPF',
    `${data.period.from} — ${data.period.to}`,
    [['Total Retenciones', fmt(data.summary.totalRetentions)]],
    ['NIF', 'Nombre', 'Tipo', 'Base', 'Retención'],
    rows,
  );
}

// ─── Tesorería ───────────────────────────────────────────────────────────────

export function exportTreasuryToCsv(data: TreasuryReportData): void {
  const rows = data.movements.map(m => ({
    Fecha: m.date,
    Descripción: m.description,
    Referencia: m.reference,
    'Importe (€)': m.amount,
    'Saldo (€)': m.balance,
  }));
  exportToCsv(`tesoreria_${data.period.from}_${data.period.to}.csv`, rows, ['Fecha', 'Descripción', 'Referencia', 'Importe (€)', 'Saldo (€)']);
}

export function exportTreasuryToExcel(data: TreasuryReportData): void {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(
    data.movements.map(m => ({
      Fecha: m.date,
      Descripción: m.description,
      Referencia: m.reference,
      'Importe (€)': m.amount,
      'Saldo (€)': m.balance,
    }))
  );
  XLSX.utils.book_append_sheet(wb, ws, 'Movimientos');
  downloadXlsx(wb, `tesoreria_${data.period.from}_${data.period.to}.xlsx`);
}

export function exportTreasuryToPdf(data: TreasuryReportData): void {
  const rows = data.movements.map(m => [m.date, m.description, m.reference, fmt(m.amount), fmt(m.balance)]);
  printHtml(
    'Informe de Tesorería',
    `${data.period.from} — ${data.period.to}`,
    [
      ['Saldo Apertura', fmt(data.summary.openingBalance)],
      ['Total Entradas', fmt(data.summary.totalIn)],
      ['Total Salidas', fmt(data.summary.totalOut)],
      ['Saldo Cierre', fmt(data.summary.closingBalance)],
    ],
    ['Fecha', 'Descripción', 'Referencia', 'Importe', 'Saldo'],
    rows,
  );
}
