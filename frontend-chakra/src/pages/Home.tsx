import React from 'react';
import { Link as RouterLink, useNavigate } from 'react-router-dom';
import { Box, Container, Heading, Link, SimpleGrid, Button, HStack, Text } from '@chakra-ui/react';

const ENLACES = [
  { to: '/lector', label: 'Lector de facturas' },
  { to: '/sales/facturas', label: 'Facturas de ingreso' },
  { to: '/sales/clientes', label: 'Clientes' },
  { to: '/sales/proveedores', label: 'Proveedores' },
  { to: '/sales/compras', label: 'Compras (gastos)' },
  { to: '/sales/productos', label: 'Productos' },
  { to: '/tesoreria/cuentas', label: 'Cuentas bancarias' },
  { to: '/tesoreria/extractos', label: 'Extractos bancarios' },
  { to: '/tesoreria/conciliacion', label: 'Conciliación bancaria' },
  { to: '/accounting/dashboard', label: 'Dashboard contable' },
  { to: '/accounting/journal-entries', label: 'Libro diario (asientos)' },
  { to: '/accounting/cierres', label: 'Cierre de ejercicio' },
  { to: '/accounting/plan-contable', label: 'Plan contable' },
  { to: '/tax/sociedades', label: 'Modelo 200 (Sociedades)' },
  { to: '/admin/empresas', label: 'Admin · Empresas' },
  { to: '/admin/usuarios', label: 'Admin · Usuarios' },
  { to: '/reports/balance', label: 'Balance de situación' },
  { to: '/reports/profit-and-loss', label: 'Pérdidas y ganancias' },
  { to: '/reports/ledger', label: 'Mayor de cuentas' },
  { to: '/reports/analytics/customers', label: 'Análisis por cliente' },
  { to: '/tax/vat-books', label: 'Libros de IVA' },
  { to: '/tax/summary', label: 'Resumen de impuestos' },
  { to: '/ayuda', label: 'Ayuda' },
  { to: '/api-test', label: 'Probador de API' },
];

export function HomePage(): React.ReactElement {
  const navigate = useNavigate();

  const handleLogout = () => {
    localStorage.removeItem('jwt_token');
    localStorage.removeItem('company_id');
    navigate('/login');
  };

  return (
    <Container maxW="3xl" py={10}>
      <HStack justify="space-between" mb={8}>
        <Heading size="lg">Conta API — Segunda piel (Chakra)</Heading>
        <Button size="sm" variant="outline" onClick={handleLogout}>Cerrar sesión</Button>
      </HStack>
      <Text color="gray.500" mb={6}>
        Vistas avanzadas de contabilidad, informes e impuestos (Fases 1-4).
      </Text>
      <SimpleGrid columns={[1, 2]} spacing={4}>
        {ENLACES.map((enlace) => (
          <Box key={enlace.to} borderWidth="1px" borderRadius="md" p={4}>
            <Link as={RouterLink} to={enlace.to} fontWeight="semibold">
              {enlace.label}
            </Link>
          </Box>
        ))}
      </SimpleGrid>
    </Container>
  );
}
