// Permisos a medida por usuario y empresa (sin BD).
//
// La matriz habla en 6 areas con 3 niveles; el servidor la traduce a codigos
// de permiso y guarda la lista canonica. Nada de lo que se guarde o se mande
// puede dar '*', 'admin:global', 'admin:empresa' ni 'config:write': eso solo lo
// tienen el perfil Administrador y el admin global, que nunca se recortan.
import {
  AREAS,
  PERMISOS,
  PERMISOS_PERSONALIZABLES,
  areasDePerfil,
  areasDePermisos,
  canonizarParaGuardar,
  cubrePermisos,
  esquemaAreas,
  leerPersonalizados,
  permisosDeAcceso,
  permisosDeAreas,
  permisosDeRoles,
  permisosEnEmpresa,
  permisosPorEmpresaDe,
  personalizadoPorEmpresaDe,
  rolNormalizado,
  type Areas,
} from '../services/rbac.service';
import { authorize } from '../middleware/authorize.middleware';
import { construirContexto, tiene } from '../services/carmen/contexto';
import { conservaPermiso } from '../services/carmen/sesiones';
import type { AuthUser } from '../types/express';

const NADA: Areas = { ventas: 'ninguno', compras: 'ninguno', contabilidad: 'ninguno', tesoreria: 'ninguno', impuestos: 'ninguno', nominas: 'ninguno' };
const ordenado = (l: string[]) => [...l].sort();

describe('catalogo de areas', () => {
  it('cada perfil fijo cabe exacto en la matriz; el Administrador es "todo"', () => {
    for (const rol of ['contable', 'ventas', 'solo_lectura']) {
      const areas = areasDePerfil(rol);
      expect(areas).not.toBeNull();
      expect(permisosDeAreas(areas!)).toEqual(ordenado(permisosDeRoles([rol])));
    }
    expect(areasDePerfil('admin')).toBeNull();
    expect(areasDePerfil('solo-lectura')).toEqual(areasDePerfil('solo_lectura'));
  });

  it('las areas solo usan codigos del catalogo y ninguno de administrador', () => {
    const catalogo = new Set(PERMISOS.map((p) => p.code));
    expect(PERMISOS_PERSONALIZABLES.size).toBe(13);
    for (const c of PERMISOS_PERSONALIZABLES) expect(catalogo.has(c)).toBe(true);
    for (const c of ['*', 'admin:global', 'admin:empresa', 'config:write']) expect(PERMISOS_PERSONALIZABLES.has(c)).toBe(false);
    expect(AREAS.map((a) => a.clave)).toEqual(['ventas', 'compras', 'contabilidad', 'tesoreria', 'impuestos', 'nominas']);
  });

  it('Modificar implica Ver', () => {
    expect(permisosDeAreas({ ...NADA, ventas: 'modificar' })).toEqual(['ventas:read', 'ventas:write']);
  });

  it('Impuestos con Ver incluye la AEAT; con ninguno, ninguno de los dos', () => {
    const ver = permisosDeAreas({ ...NADA, impuestos: 'ver' });
    expect(ver).toEqual(['aeat:read', 'impuestos:read']);
    const nada = permisosDeAreas({ ...NADA, ventas: 'ver' });
    expect(nada).not.toContain('impuestos:read');
    expect(nada).not.toContain('aeat:read');
  });

  it('areasDePermisos: modificar, ver o ninguno; con * todo modificar', () => {
    expect(areasDePermisos(['ventas:read', 'ventas:write', 'compras:read'])).toEqual({ ...NADA, ventas: 'modificar', compras: 'ver' });
    // Escribir sin leer no es "modificar": se queda en ninguno.
    expect(areasDePermisos(['ventas:write']).ventas).toBe('ninguno');
    expect(Object.values(areasDePermisos(['*']))).toEqual(Array(6).fill('modificar'));
  });

  it('rolNormalizado pasa solo-lectura a solo_lectura', () => {
    expect(rolNormalizado('solo-lectura')).toBe('solo_lectura');
    expect(rolNormalizado('contable')).toBe('contable');
  });
});

describe('esquemaAreas (lo que acepta la API)', () => {
  it('acepta las 6 areas con sus 3 niveles', () => {
    expect(esquemaAreas.safeParse({ ...NADA, ventas: 'ver', nominas: 'modificar' }).success).toBe(true);
  });

  it('rechaza claves de mas, areas que faltan, niveles raros y tipos que no son objeto', () => {
    for (const extra of ['admin', 'config', '*', 'configuracion']) {
      expect(esquemaAreas.safeParse({ ...NADA, [extra]: 'modificar' }).success).toBe(false);
    }
    const { nominas: _quitada, ...sinNominas } = NADA;
    expect(esquemaAreas.safeParse(sinNominas).success).toBe(false);
    expect(esquemaAreas.safeParse({ ...NADA, ventas: 'todo' }).success).toBe(false);
    expect(esquemaAreas.safeParse({ ...NADA, ventas: 'write' }).success).toBe(false);
    expect(esquemaAreas.safeParse(['ventas:read']).success).toBe(false);
    expect(esquemaAreas.safeParse('ventas').success).toBe(false);
  });
});

describe('leerPersonalizados (la columna de la BD)', () => {
  it('null o undefined: los del perfil', () => {
    expect(leerPersonalizados(null)).toBeNull();
    expect(leerPersonalizados(undefined)).toBeNull();
  });

  it('se queda solo con los personalizables y aplica las implicaciones', () => {
    expect(leerPersonalizados(['*', 'admin:global', 'admin:empresa', 'config:write', 'ventas:write'])).toEqual(['ventas:read', 'ventas:write']);
    expect(leerPersonalizados(['aeat:read'])).toEqual([]);
    expect(leerPersonalizados(['ventas:*'])).toEqual([]);
  });

  it('cualquier otro formato cierra el paso: sin permisos de area', () => {
    for (const raro of [{ a: 1 }, 'ventas:read', 42, [1, 2], ['ventas:read', 3]]) expect(leerPersonalizados(raro)).toEqual([]);
  });
});

describe('permisosDeAcceso (la unica funcion que decide)', () => {
  it('el admin global lo tiene todo aunque su acceso este personalizado', () => {
    expect(permisosDeAcceso({ role: 'contable', permisosPersonalizados: ['ventas:read'] }, true)).toEqual(['*']);
    expect(permisosDeAcceso(undefined, true)).toEqual(['*']);
  });

  it('el perfil Administrador ignora lo personalizado (datos viejos en la columna)', () => {
    expect(permisosDeAcceso({ role: 'admin', permisosPersonalizados: ['ventas:read'] }, false)).toEqual(['*']);
    expect(personalizadoPorEmpresaDe([{ companyId: 'E', role: 'admin', permisosPersonalizados: ['ventas:read'] }])).toEqual({ E: false });
  });

  it('contable personalizado: lo personalizado; sin personalizar: su perfil; sin acceso: nada', () => {
    expect(permisosDeAcceso({ role: 'contable', permisosPersonalizados: ['ventas:read'] }, false)).toEqual(['ventas:read']);
    expect(ordenado(permisosDeAcceso({ role: 'contable', permisosPersonalizados: null }, false))).toEqual(ordenado(permisosDeRoles(['contable'])));
    expect(permisosDeAcceso(undefined, false)).toEqual([]);
    expect(personalizadoPorEmpresaDe([{ companyId: 'E', role: 'contable', permisosPersonalizados: ['ventas:read'] }])).toEqual({ E: true });
  });

  it('dos membresias de la misma empresa (prisma simulado) se unen', () => {
    const r = permisosPorEmpresaDe(
      [
        { companyId: 'E', role: 'ventas', permisosPersonalizados: null },
        { companyId: 'E', role: 'contable', permisosPersonalizados: ['nominas:read'] },
      ],
      false,
    );
    expect(r.E).toEqual(expect.arrayContaining(['ventas:read', 'ventas:write', 'contabilidad:read', 'nominas:read']));
    expect(new Set(r.E).size).toBe(r.E.length);
  });
});

describe('canonizarParaGuardar', () => {
  it('igual al perfil o null: no es personalizado', () => {
    expect(canonizarParaGuardar('contable', areasDePerfil('contable'))).toBeNull();
    expect(canonizarParaGuardar('contable', null)).toBeNull();
  });

  it('el Administrador no se personaliza y todo en ninguno no vale', () => {
    expect(() => canonizarParaGuardar('admin', { ...NADA, ventas: 'ver' })).toThrow(expect.objectContaining({ statusCode: 400, details: { campo: 'areas' } }));
    expect(() => canonizarParaGuardar('contable', NADA)).toThrow(expect.objectContaining({ statusCode: 400, details: { campo: 'areas' } }));
  });

  it('distinto del perfil: la lista canonica', () => {
    expect(canonizarParaGuardar('contable', { ...areasDePerfil('contable')!, compras: 'ninguno' })).toEqual(
      ordenado(permisosDeRoles(['contable']).filter((p) => !p.startsWith('compras:'))),
    );
  });
});

describe('decisiones con permisos personalizados', () => {
  it('solo Ventas no cubre contabilidad, admin:empresa, config:write ni admin:global', () => {
    const soloVentas = permisosDeAreas({ ...NADA, ventas: 'modificar' });
    for (const p of ['contabilidad:read', 'admin:empresa', 'config:write', 'admin:global']) expect(cubrePermisos(soloVentas, [p])).toBe(false);
  });

  it('permisosEnEmpresa usa permisosPorEmpresa; empresa fuera del mapa: nada; sin empresa: la union del mapa', () => {
    const user = { roles: ['contable'], rolesPorEmpresa: { E: ['contable'], F: ['contable'] }, permisosPorEmpresa: { E: ['ventas:read'], F: ['nominas:read'] } };
    expect(permisosEnEmpresa(user, 'E')).toEqual(['ventas:read']);
    expect(permisosEnEmpresa(user, 'Z')).toEqual([]);
    const union = permisosEnEmpresa(user);
    expect(ordenado(union)).toEqual(['nominas:read', 'ventas:read']);
    // Un contable personalizado sin compras no recibe compras:read por la via sin empresa.
    expect(union).not.toContain('compras:read');
    // Sin el mapa (tokens de desarrollo, tests sin BD): por roles.
    expect(permisosEnEmpresa({ rolesPorEmpresa: { E: ['ventas'] } }, 'E')).toEqual(expect.arrayContaining(['ventas:read', 'ventas:write']));
  });

  it('authorize mira los permisos personalizados de la empresa de la ruta', () => {
    const pasa = (permisosPorEmpresa: Record<string, string[]>) => {
      const next = jest.fn();
      authorize('compras:read')({ user: { userId: 'u', roles: ['contable'], companies: ['E'], permisosPorEmpresa }, companyId: 'E' } as never, {} as never, next);
      return next.mock.calls[0][0];
    };
    const error = pasa({ E: ['ventas:read'] });
    expect(error).toMatchObject({
      statusCode: 403,
      message: 'No tienes permiso para esto en esta empresa. Si lo necesitas, pídeselo al administrador.',
      details: { permisos: ['compras:read'] },
    });
    expect(pasa({ E: ['compras:read'] })).toBeUndefined();
  });

  it('Carmen decide con los mismos permisos personalizados', () => {
    const user: AuthUser = {
      userId: 'u',
      roles: ['contable'],
      companies: ['E'],
      rolesPorEmpresa: { E: ['contable'] },
      permisosPorEmpresa: { E: permisosDeAreas({ ...NADA, ventas: 'modificar' }) },
    };
    const ctx = construirContexto(user, 'E');
    expect(ctx.puedeNominas).toBe(false);
    expect(tiene(ctx, 'contabilidad:read')).toBe(false);
    expect(ctx.esAdminEmpresa).toBe(false);

    const global = construirContexto({ ...user, esAdminGlobal: true }, 'E');
    expect(global.puedeNominas).toBe(true);
    expect(tiene(global, 'contabilidad:read')).toBe(true);
    expect(global.esAdminEmpresa).toBe(true);

    expect(construirContexto({ ...user, rolesPorEmpresa: { E: ['admin'] }, permisosPorEmpresa: { E: ['*'] } }, 'E').esAdminEmpresa).toBe(true);

    // Una respuesta guardada con ventas:read|contabilidad:read se oculta si ya no tiene ninguno de los dos.
    const sinNada = construirContexto({ ...user, permisosPorEmpresa: { E: ['nominas:read'] } }, 'E');
    expect(conservaPermiso(sinNada, 'ventas:read|contabilidad:read')).toBe(false);
    expect(conservaPermiso(ctx, 'ventas:read|contabilidad:read')).toBe(true);
  });
});
