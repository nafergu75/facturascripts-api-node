import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/utils/password';
import { encrypt } from '../src/utils/crypto';

const prisma = new PrismaClient();

/**
 * Datos semilla de desarrollo:
 *  - Empresa "1" -> apunta al FacturaScripts local (su API Key se guarda CIFRADA).
 *  - Usuario demo@empresa.com / demo1234.
 *  - Membresia admin del usuario sobre la empresa "1".
 */
async function main(): Promise<void> {
  const fsBaseUrl = process.env.FS_API_URL ?? 'http://localhost:8000/api/3';
  const fsApiKey = process.env.FS_API_KEY ?? '';

  const company = await prisma.company.upsert({
    where: { id: '1' },
    update: { name: 'Empresa Demo', fsBaseUrl, fsApiKeyEnc: encrypt(fsApiKey), isActive: true },
    create: { id: '1', name: 'Empresa Demo', fsBaseUrl, fsApiKeyEnc: encrypt(fsApiKey), isActive: true },
  });

  const user = await prisma.user.upsert({
    where: { email: 'demo@empresa.com' },
    update: { isActive: true },
    create: { email: 'demo@empresa.com', passwordHash: hashPassword('demo1234'), isActive: true },
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
