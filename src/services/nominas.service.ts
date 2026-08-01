import { NominaResumen } from '../domain/nominas.model';
import { AsientoContableGenerado, LineaAsiento } from '../domain/asiento.model';
import { prisma } from '../config/database';

const aResumen = (n: {
  id: string;
  companyId: string;
  mes: number;
  ejercicio: number;
  totalBruto: number;
  totalSeguridadSocialEmpresa: number;
  totalSeguridadSocialTrabajador: number;
  totalIRPF: number;
  totalLiquido: number;
}): NominaResumen => ({
  id: n.id,
  companyId: n.companyId,
  mes: n.mes,
  ejercicio: n.ejercicio,
  totalBruto: n.totalBruto,
  totalSeguridadSocialEmpresa: n.totalSeguridadSocialEmpresa,
  totalSeguridadSocialTrabajador: n.totalSeguridadSocialTrabajador,
  totalIRPF: n.totalIRPF,
  totalLiquido: n.totalLiquido,
});

/**
 * Genera la estructura de asiento contable de una nomina (PGC):
 *   DEBE  640 Sueldos y salarios (bruto)
 *   DEBE  642 Seguridad Social a cargo de la empresa
 *   HABER 476 Organismos S.S. acreedores (SS empresa + SS trabajador)
 *   HABER 4751 HP acreedora por retenciones (IRPF)
 *   HABER 465 Remuneraciones pendientes de pago (liquido)
 *
 * PENDIENTE BLOQUEADO: esta funcion calcula la estructura correcta pero NO se
 * invoca para contabilizar de forma automatica (ver importarResumenNominas). La
 * integracion con asientos.service.ts (FacturaScripts) requiere validar contra
 * una instancia FS real antes de activarla, para no generar asientos incorrectos.
 */
export function generarAsientoNomina(resumen: NominaResumen): AsientoContableGenerado {
  const concepto = `Nomina ${resumen.mes}/${resumen.ejercicio}`;
  const lineas: LineaAsiento[] = [
    { subcuenta: '640', debe: resumen.totalBruto, haber: 0, concepto },
    { subcuenta: '642', debe: resumen.totalSeguridadSocialEmpresa, haber: 0, concepto },
    { subcuenta: '476', debe: 0, haber: resumen.totalSeguridadSocialEmpresa + resumen.totalSeguridadSocialTrabajador, concepto },
    { subcuenta: '4751', debe: 0, haber: resumen.totalIRPF, concepto },
    { subcuenta: '465', debe: 0, haber: resumen.totalLiquido, concepto },
  ];
  const debeTotal = Math.round((lineas.reduce((a, l) => a + l.debe, 0) + Number.EPSILON) * 100) / 100;
  const haberTotal = Math.round((lineas.reduce((a, l) => a + l.haber, 0) + Number.EPSILON) * 100) / 100;
  // El cuadre exacto depende de que bruto = liquido + IRPF + SS trabajador, validado por quien
  // introduce el resumen (la cabecera no recalcula ni corrige estos importes).
  return { fecha: `${resumen.ejercicio}-${String(resumen.mes).padStart(2, '0')}-28`, descripcion: concepto, lineas, debeTotal, haberTotal };
}

export async function importarResumenNominas(companyId: string, resumen: Omit<NominaResumen, 'id'>): Promise<NominaResumen> {
  const guardado = await prisma.nominaResumen.create({
    data: {
      companyId,
      mes: resumen.mes,
      ejercicio: resumen.ejercicio,
      totalBruto: resumen.totalBruto,
      totalSeguridadSocialEmpresa: resumen.totalSeguridadSocialEmpresa,
      totalSeguridadSocialTrabajador: resumen.totalSeguridadSocialTrabajador,
      totalIRPF: resumen.totalIRPF,
      totalLiquido: resumen.totalLiquido,
    },
  });
  // No se contabiliza automaticamente: ver PENDIENTE BLOQUEADO en generarAsientoNomina.
  return aResumen(guardado);
}

export async function listarResumenesNominas(companyId: string, ejercicio: number): Promise<NominaResumen[]> {
  const resumenes = await prisma.nominaResumen.findMany({
    where: { companyId, ejercicio },
    orderBy: { mes: 'asc' },
  });
  return resumenes.map(aResumen);
}
