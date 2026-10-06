import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/utils/password';
import { encrypt } from '../src/utils/crypto';

const prisma = new PrismaClient();

/**
 * Datos semilla de desarrollo:
 *  - Empresa "1" -> apunta al FacturaScripts local (su API Key se guarda CIFRADA).
 *  - Usuario demo@empresa.com. Contrasena: SEED_DEMO_PASSWORD; en local, si no
 *    se define, 'demo1234'. En produccion es obligatoria: 'demo1234' aparece en
 *    la documentacion y daria acceso de admin a la contabilidad.
 *  - Membresia admin del usuario sobre la empresa "1".
 */
function contrasenaDemo(): string {
  const definida = process.env.SEED_DEMO_PASSWORD;
  if (definida) {
    if (definida.length < 12) throw new Error('SEED_DEMO_PASSWORD debe tener al menos 12 caracteres.');
    return definida;
  }
  if (process.env.NODE_ENV === 'production' || process.env.VERCEL) {
    throw new Error('En produccion define SEED_DEMO_PASSWORD: la contrasena por defecto es publica.');
  }
  return 'demo1234';
}

async function main(): Promise<void> {
  const password = contrasenaDemo();
  const fsBaseUrl = process.env.FS_API_URL ?? 'http://localhost:8000/api/3';
  const fsApiKey = process.env.FS_API_KEY ?? '';

  const company = await prisma.company.upsert({
    where: { id: '1' },
    update: { name: 'Empresa Demo', fsBaseUrl, fsApiKeyEnc: encrypt(fsApiKey), isActive: true },
    create: { id: '1', name: 'Empresa Demo', fsBaseUrl, fsApiKeyEnc: encrypt(fsApiKey), isActive: true },
  });

  const user = await prisma.user.upsert({
    where: { email: 'demo@empresa.com' },
    // update tambien fija la contrasena: re-ejecutar el seed la cambia.
    update: { isActive: true, passwordHash: hashPassword(password) },
    create: { email: 'demo@empresa.com', passwordHash: hashPassword(password), isActive: true },
  });

  await prisma.membership.upsert({
    where: { userId_companyId: { userId: user.id, companyId: company.id } },
    update: { role: 'admin' },
    create: { userId: user.id, companyId: company.id, role: 'admin' },
  });

  // eslint-disable-next-line no-console
  console.log(`Seed OK -> empresa ${company.id}, usuario ${user.email}`);
}

main()
  .catch((e) => {
    // eslint-disable-next-line no-console
    console.error('Seed error:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
