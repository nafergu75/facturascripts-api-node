/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/tests/**/*.test.ts'],
  setupFiles: ['<rootDir>/src/tests/jest.setup.ts'],
  // Cierra el cliente Prisma de cada fichero al acabarlo (ver jest.cerrar-bd.ts).
  setupFilesAfterEnv: ['<rootDir>/src/tests/jest.cerrar-bd.ts'],
  clearMocks: true,
  // Cierra conexiones Prisma abiertas al final (evita que Jest se quede colgado).
  forceExit: true,
  // Timeout por test: 30s (las operaciones de BD pueden tardar en CI).
  testTimeout: 30000,
};
