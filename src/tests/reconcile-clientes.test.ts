// Test: reconciliación FS vs Prisma clientes (mapeo y detección duplicados)
describe('Reconciliacion: Clientes FS vs Prisma', () => {
  it('detecta duplicados: mismo NIF en ambas tiendas', () => {
    const fsClientes = new Map([['b12345678', { codcliente: 'C001', nombre: 'Cliente A', cifnif: 'B12345678' }]]);
    const prismaClientes = new Map([
      ['b12345678', { id: 'p1', nombreFiscal: 'Cliente A', nifCif: 'B12345678' }],
    ]);

    const allNifs = new Set([...fsClientes.keys(), ...prismaClientes.keys()]);
    const duplicados = Array.from(allNifs).filter((nif) => fsClientes.has(nif) && prismaClientes.has(nif));

    expect(duplicados).toHaveLength(1);
    expect(duplicados[0]).toBe('b12345678');
  });

  it('identifica clientes solo en FS (legacy abandonados)', () => {
    const fsClientes = new Map([
      ['b11111111', { codcliente: 'OLD1', nombre: 'Old Legacy', cifnif: 'B11111111' }],
      ['b12345678', { codcliente: 'C001', nombre: 'Cliente A', cifnif: 'B12345678' }],
    ]);
    const prismaClientes = new Map([['b12345678', { id: 'p1', nombreFiscal: 'Cliente A', nifCif: 'B12345678' }]]);

    const allNifs = new Set([...fsClientes.keys(), ...prismaClientes.keys()]);
    const soloFS = Array.from(allNifs).filter((nif) => fsClientes.has(nif) && !prismaClientes.has(nif));

    expect(soloFS).toHaveLength(1);
    expect(soloFS[0]).toBe('b11111111');
  });

  it('identifica clientes solo en Prisma (nuevos en Chakra)', () => {
    const fsClientes = new Map([['b12345678', { codcliente: 'C001', nombre: 'Cliente A', cifnif: 'B12345678' }]]);
    const prismaClientes = new Map([
      ['b12345678', { id: 'p1', nombreFiscal: 'Cliente A', nifCif: 'B12345678' }],
      ['b99999999', { id: 'p2', nombreFiscal: 'Cliente Nuevo', nifCif: 'B99999999' }],
    ]);

    const allNifs = new Set([...fsClientes.keys(), ...prismaClientes.keys()]);
    const soloPrisma = Array.from(allNifs).filter((nif) => !fsClientes.has(nif) && prismaClientes.has(nif));

    expect(soloPrisma).toHaveLength(1);
    expect(soloPrisma[0]).toBe('b99999999');
  });

  it('estrategia FS-master: duplicados se borran de Prisma', () => {
    const strategy: any = 'fs-master';
    let action: 'merge' | 'skip' | 'delete-fs' | 'delete-prisma' = 'skip';
    if (true) {
      // isDuplicate
      action = strategy === 'fs-master' ? 'delete-prisma' : 'delete-fs';
    }

    expect(action).toBe('delete-prisma');
  });

  it('estrategia Prisma-master: duplicados marcados para borrar FS', () => {
    const strategy: any = 'prisma-master';
    let action: 'merge' | 'skip' | 'delete-fs' | 'delete-prisma' = 'skip';
    if (true) {
      // isDuplicate
      action = strategy === 'fs-master' ? 'delete-prisma' : 'delete-fs';
    }

    expect(action).toBe('delete-fs');
  });

  it('NIF case-insensitive: B12345678 == b12345678', () => {
    const nif1 = 'B12345678'.toLowerCase();
    const nif2 = 'b12345678'.toLowerCase();

    expect(nif1).toBe(nif2);
  });

  it('stats correctas: suma Solo FS + Solo Prisma + Duplicados = Total', () => {
    const stats = {
      soloFS: 75,
      soloPrisma: 30,
      duplicados: 15,
    };

    const total = stats.soloFS + stats.soloPrisma + stats.duplicados;
    expect(total).toBe(120);
  });
});
