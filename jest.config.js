/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/tests/**/*.test.ts'],
  setupFiles: ['<rootDir>/src/tests/jest.setup.ts'],
  clearMocks: true,
  // Cierra conexiones Prisma abiertas al final (evita que Jest se quede colgado).
  forceExit: true,
  // Timeout por test: 30s (las operaciones de BD pueden tardar en CI).
  testTimeout: 30000,
};
