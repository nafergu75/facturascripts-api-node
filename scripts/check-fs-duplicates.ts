import axios from 'axios';

const FS_API_URL = process.env.FS_API_URL || 'http://localhost:8000/api/3';
const FS_API_KEY = process.env.FS_API_KEY || '';

const fsClient = axios.create({
  baseURL: FS_API_URL,
  headers: { Token: FS_API_KEY },
});

interface FSCliente {
  codcliente: string;
  nombre: string;
  cifnif: string;
}

async function checkDuplicates() {
  console.log('🔍 Detectando NIFs duplicados en FS...\n');

  try {
    const res = await fsClient.get('/clientes?limit=500');
    const clientes = res.data.items as FSCliente[];
    console.log(`Leyendo ${clientes.length} clientes de FS`);

    // Agrupar por NIF
    const byNif = new Map<string, FSCliente[]>();
    for (const c of clientes) {
      const nif = c.cifnif.toLowerCase();
      if (!byNif.has(nif)) byNif.set(nif, []);
      byNif.get(nif)!.push(c);
    }

    // Encontrar duplicados
    const dups = Array.from(byNif.entries()).filter(([_, group]) => group.length > 1);

    if (dups.length === 0) {
      console.log('✅ Sin duplicados en FS: migración segura');
      return;
    }

    console.log(`\n⚠️  ${dups.length} NIFs duplicados encontrados:\n`);
    console.log('NIF              | Count | Clientes');
    console.log('-'.repeat(70));

    for (const [nif, group] of dups) {
      const nombres = group.map((c) => `${c.codcliente}:${c.nombre}`).join(' | ');
      console.log(`${nif.padEnd(16)} | ${String(group.length).padEnd(5)} | ${nombres}`);
    }

    console.log('\n📝 SOLUCIÓN (manual en FS o pre-migración):\n');
    console.log('Opción 1: Editar en FS UI -> cambiar NIF a uno único');
    console.log('Opción 2: Script pre-migración: cambiar NIF programáticamente');
    console.log('Opción 3: Borrar en FS uno de los duplicados (perder datos)');
    console.log('\nRecomendado: merge en FS (consolidar a 1 cliente con el NIF)');
    console.log('luego re-ejecutar migración.');
  } catch (e: any) {
    console.error(`❌ Error: ${e.message}`);
    process.exit(1);
  }
}

checkDuplicates();
