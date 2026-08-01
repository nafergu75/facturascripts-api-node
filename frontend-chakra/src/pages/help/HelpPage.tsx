/**
 * Página: Centro de ayuda
 * Ruta: /ayuda
 *
 * Buscador sobre helpArticles (título + contenido + keywords, case-insensitive)
 * con resaltado de coincidencias. Debajo del buscador se mantiene contenido fijo
 * (referencia de API y enlaces) que no forma parte de la base de conocimiento
 * buscable. No llama a ningún endpoint — es documentación, no datos en vivo.
 */

import React, { useMemo, useState } from 'react';
import {
  Box,
  Code,
  Container,
  Divider,
  Heading,
  Highlight,
  HStack,
  Icon,
  Input,
  InputGroup,
  InputLeftElement,
  Link,
  List,
  ListItem,
  Tag,
  Text,
  VStack,
} from '@chakra-ui/react';
import { InfoOutlineIcon, SearchIcon } from '@chakra-ui/icons';
import { HelpArticle, helpArticles } from './helpData';

const MODULE_LABEL: Record<HelpArticle['module'], string> = {
  lector: 'Lector de facturas',
  contabilidad: 'Contabilidad',
  informes: 'Informes y exportaciones',
  seguridad: 'Seguridad y acceso',
  general: 'General',
};

const MODULE_COLOR: Record<HelpArticle['module'], string> = {
  lector: 'purple',
  contabilidad: 'blue',
  informes: 'green',
  seguridad: 'orange',
  general: 'gray',
};

function SubHeading({ children }: { children: React.ReactNode }) {
  return <Text fontSize="sm" fontWeight="bold" color="gray.600" mt={3} mb={1}>{children}</Text>;
}

const ALL_MODULES = Object.keys(MODULE_LABEL) as HelpArticle['module'][];

/** Quita tildes para que "retención" encuentre "retenciones" y viceversa (singular/plural cambia el acento en español). */
function sinTildes(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

export function HelpPage(): React.ReactElement {
  const [query, setQuery] = useState('');
  const [selectedModule, setSelectedModule] = useState<HelpArticle['module'] | null>(null);
  const normalizedQuery = sinTildes(query.trim().toLowerCase());

  const filtered = useMemo<HelpArticle[]>(() => {
    return helpArticles.filter((article) => {
      if (selectedModule && article.module !== selectedModule) return false;
      if (!normalizedQuery) return true;
      const haystack = sinTildes(`${article.title} ${article.content} ${article.keywords.join(' ')}`.toLowerCase());
      return haystack.includes(normalizedQuery);
    });
  }, [normalizedQuery, selectedModule]);

  const sinResultados = filtered.length === 0;

  function contarPorModulo(m: HelpArticle['module']): number {
    return helpArticles.filter((a) => a.module === m).length;
  }

  return (
    <Container maxW="4xl" py={8}>
      <VStack align="stretch" spacing={6}>
        <Box>
          <Heading as="h1" size="lg" mb={2}>Centro de ayuda</Heading>
          <Text color="gray.600">
            Busca por palabra clave (por ejemplo "lector", "contabilizar", "IVA", "DRAFT") o
            explora los artículos por módulo.
          </Text>
        </Box>

        <InputGroup maxW="480px">
          <InputLeftElement pointerEvents="none">
            <SearchIcon color="gray.400" />
          </InputLeftElement>
          <Input
            placeholder="Buscar en la ayuda…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Buscar en la ayuda"
          />
        </InputGroup>

        <HStack spacing={2} wrap="wrap" role="group" aria-label="Filtrar por módulo">
          {ALL_MODULES.filter((m) => contarPorModulo(m) > 0).map((m) => (
            <Tag
              key={m}
              as="button"
              size="sm"
              cursor="pointer"
              variant={selectedModule === m ? 'solid' : 'outline'}
              colorScheme={MODULE_COLOR[m]}
              onClick={() => setSelectedModule(selectedModule === m ? null : m)}
              aria-pressed={selectedModule === m}
            >
              {MODULE_LABEL[m]} ({contarPorModulo(m)})
            </Tag>
          ))}
          {selectedModule && (
            <Tag as="button" size="sm" variant="ghost" cursor="pointer" onClick={() => setSelectedModule(null)}>
              Quitar filtro ✕
            </Tag>
          )}
        </HStack>

        {sinResultados && (
          <Box bg="yellow.50" borderRadius="md" p={4}>
            <HStack spacing={3} align="start">
              <Icon as={InfoOutlineIcon} color="yellow.500" mt={0.5} />
              <Text fontSize="sm" color="yellow.800">
                {query
                  ? `No se han encontrado resultados para "${query}"${selectedModule ? ` en ${MODULE_LABEL[selectedModule]}` : ''}. Prueba con otras palabras clave (por ejemplo, "IVA", "retenciones", "lector", "asiento") o quita el filtro de módulo.`
                  : 'No hay artículos en este módulo todavía.'}
              </Text>
            </HStack>
          </Box>
        )}

        <VStack align="stretch" spacing={3}>
          {filtered.map((article) => (
            <Box key={article.id} borderWidth="1px" borderRadius="md" p={4} bg="white">
              <HStack justify="space-between" align="start" mb={1}>
                <Heading as="h2" size="sm">
                  <Highlight query={normalizedQuery ? [query] : []} styles={{ bg: 'yellow.200' }}>
                    {article.title}
                  </Highlight>
                </Heading>
                <Tag size="sm" colorScheme={MODULE_COLOR[article.module]} flexShrink={0}>
                  {MODULE_LABEL[article.module]}
                </Tag>
              </HStack>
              <Text fontSize="sm" color="gray.700">
                <Highlight query={normalizedQuery ? [query] : []} styles={{ bg: 'yellow.200' }}>
                  {article.content}
                </Highlight>
              </Text>
            </Box>
          ))}
        </VStack>

        <Divider />

        <Box>
          <Heading size="md" mb={3}>Referencia rápida de la API</Heading>
          <Text fontSize="sm" color="gray.600" mb={3}>
            Todos los endpoints de empresa van precedidos de{' '}
            <Code>/companies/:companyId/...</Code> y requieren cabecera{' '}
            <Code>Authorization: Bearer &lt;token&gt;</Code>.
          </Text>

          <SubHeading>Endpoints principales</SubHeading>
          <List spacing={1} fontSize="sm">
            <ListItem><Code>POST /income-reader/web-upload</Code> — subir factura para lectura</ListItem>
            <ListItem><Code>GET /income-reader/pending</Code> — documentos listos para revisar</ListItem>
            <ListItem><Code>POST /income-reader/:id/verify</Code> — crear factura de ingreso desde lo leído</ListItem>
            <ListItem><Code>POST /accounting/contabilizar/:invoiceId?tipo=INGRESO|GASTO</Code> — generar asiento</ListItem>
            <ListItem><Code>GET /reports/balance</Code>, <Code>/reports/pyg</Code>, <Code>/reports/iva</Code>, <Code>/reports/retentions</Code>, <Code>/reports/treasury</Code></ListItem>
          </List>

          <SubHeading>Parámetros habituales</SubHeading>
          <List spacing={1} fontSize="sm">
            <ListItem><Code>companyId</Code> — en la ruta, identifica la empresa (multiempresa)</ListItem>
            <ListItem><Code>desde</Code> / <Code>hasta</Code> — rango de fechas (YYYY-MM-DD) para filtrar informes</ListItem>
            <ListItem><Code>tipo</Code> — <Code>INGRESO</Code> o <Code>GASTO</Code> según el flujo</ListItem>
            <ListItem><Code>skip</Code> / <Code>take</Code> — paginación en listados</ListItem>
          </List>

          <SubHeading>Respuesta típica (estructura simplificada)</SubHeading>
          <Box bg="gray.50" borderRadius="md" p={3} fontSize="xs" fontFamily="mono" whiteSpace="pre-wrap">
{`{
  "data": {
    "journalEntryId": "ck_abc123",
    "estado": "DRAFT",
    "lineas": [
      { "cuenta": "430", "debe": 1210, "haber": 0 },
      { "cuenta": "700", "debe": 0, "haber": 1000 },
      { "cuenta": "477", "debe": 0, "haber": 210 }
    ]
  }
}`}
          </Box>
          <Text fontSize="xs" color="gray.500" mt={2}>
            Especificación completa e interactiva (Swagger):{' '}
            <Link href="http://localhost:3000/docs" color="blue.600" isExternal>
              http://localhost:3000/docs
            </Link>
          </Text>
        </Box>

        <Divider />

        <Box>
          <Heading size="md" mb={2}>Más recursos</Heading>
          <List spacing={1} fontSize="sm">
            <ListItem>
              <Link href="http://localhost:3000/docs" color="blue.600" isExternal>Documentación técnica de la API (Swagger)</Link>
            </ListItem>
            <ListItem>
              <Link href="mailto:soporte@conta-api.local" color="blue.600">soporte@conta-api.local</Link> — contacto/soporte (dirección de ejemplo, sustituye por la real)
            </ListItem>
          </List>
        </Box>
      </VStack>
    </Container>
  );
}
