import React from 'react';
import {
  Box, Container, Tabs, TabList, TabPanels, Tab, TabPanel,
  Heading, Text, VStack,
} from '@chakra-ui/react';
import { IncomeReportView } from './IncomeReportView';
import { ExpensesReportView } from './ExpensesReportView';
import { ResultReportView } from './ResultReportView';
import { VatReportView } from './VatReportView';
import { RetentionsReportView } from './RetentionsReportView';
import { TreasuryReportView } from './TreasuryReportView';

const TABS = [
  {
    label: 'Ingresos',
    hint: 'Facturación emitida contabilizada',
    component: <IncomeReportView />,
  },
  {
    label: 'Gastos',
    hint: 'Facturas recibidas contabilizadas',
    component: <ExpensesReportView />,
  },
  {
    label: 'Resultado',
    hint: 'Ingresos menos gastos',
    component: <ResultReportView />,
  },
  {
    label: 'IVA',
    hint: 'Repercutido vs soportado',
    component: <VatReportView />,
  },
  {
    label: 'Retenciones IRPF',
    hint: 'Modelo 190 — retenciones practicadas',
    component: <RetentionsReportView />,
  },
  {
    label: 'Tesorería',
    hint: 'Movimientos en cuentas 57x',
    component: <TreasuryReportView />,
  },
];

export function ReportsPage() {
  return (
    <Container maxW="6xl" py={6}>
      <VStack align="stretch" spacing={6}>

        {/*
          as="h1": único h1 de la página.
          Los informes individuales usan h2 dentro de sus secciones.
        */}
        <Box>
          <Heading as="h1" size="lg">Informes financieros</Heading>
          <Text fontSize="sm" color="gray.500" mt={0.5}>
            Datos contabilizados — filtra por año, mes o rango de fechas
          </Text>
        </Box>

        <Tabs isLazy variant="enclosed" colorScheme="blue">
          {/*
            aria-label identifica el grupo de pestañas para lectores de pantalla.
            Chakra aplica automáticamente role="tablist", role="tab", role="tabpanel"
            y las asociaciones aria-controls / aria-labelledby.
          */}
          <TabList aria-label="Tipos de informe" flexWrap="wrap">
            {TABS.map(t => (
              <Tab
                key={t.label}
                fontSize="sm"
                fontWeight="semibold"
                title={t.hint}          /* tooltip nativo en hover */
                _selected={{ color: 'blue.600', borderColor: 'blue.400' }}
              >
                {t.label}
              </Tab>
            ))}
          </TabList>

          <TabPanels>
            {TABS.map(t => (
              <TabPanel
                key={t.label}
                bg="white"
                borderRadius="md"
                boxShadow="sm"
                mt={2}
                p={5}
              >
                {t.component}
              </TabPanel>
            ))}
          </TabPanels>
        </Tabs>
      </VStack>
    </Container>
  );
}
