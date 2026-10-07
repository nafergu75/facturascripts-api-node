/**
 * Panel de chat de Carmen: mensajes, fuente de las fichas, avisos, botones e
 * input. Componentes hijos inline para mantener el modulo compacto. Las tablas
 * y cifras completas solo se ven en la ventana de frontend/web.
 */

import React, { useEffect, useRef, useState } from 'react';
import {
  Avatar,
  Box,
  Button,
  HStack,
  Input,
  Link,
  Spinner,
  Text,
  VStack,
  Wrap,
  WrapItem,
} from '@chakra-ui/react';
import { useCarmenChat, ChatMessage } from '../../hooks/useCarmenChat';
import { BotonCarmen } from '../../api/carmenApi';

const fechaES = (iso: string): string =>
  /^\d{4}-\d{2}-\d{2}/.test(iso) ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : iso;

function MessageBubble({ message }: { message: ChatMessage }): React.ReactElement {
  const isUser = message.role === 'user';
  return (
    <HStack w="100%" align="flex-start" justify={isUser ? 'flex-end' : 'flex-start'} spacing={2}>
      {!isUser && <Avatar name="Carmen" size="sm" bg="blue.500" color="white" />}
      <Box
        maxW="80%"
        px={3}
        py={2}
        borderRadius="lg"
        bg={isUser ? 'blue.500' : 'gray.100'}
        color={isUser ? 'white' : 'gray.900'}
        whiteSpace="pre-wrap"
        fontSize="sm"
      >
        {message.entendido && (
          <Text fontSize="xs" color="gray.500" mb={1}>
            He entendido: {message.entendido}
          </Text>
        )}
        {message.content}
      </Box>
    </HStack>
  );
}

/** Etiqueta de origen, la fuente de la ficha y los avisos de una respuesta. */
function Detalles({ message }: { message: ChatMessage }): React.ReactElement | null {
  const origen =
    message.origen === 'datos'
      ? 'Tus datos'
      : message.origen === 'faq'
        ? 'Pregunta frecuente'
        : message.origen === 'ia'
          ? 'Respuesta orientativa de IA: no ha visto tus datos'
          : null;
  if (!origen && !message.avisos?.length && !message.fuente) return null;
  return (
    <VStack w="100%" pl={10} align="flex-start" spacing={1} fontSize="xs" color="gray.600">
      {origen && (
        <Text fontWeight="semibold" color={message.origen === 'ia' ? 'orange.600' : message.origen === 'datos' ? 'green.700' : 'gray.600'}>
          {origen}
        </Text>
      )}
      {message.fuente && (
        <Text>
          Fuente:{' '}
          <Link href={message.fuente.url} isExternal color="blue.600">
            {message.fuente.titulo}
          </Link>{' '}
          · verificada {fechaES(message.fuente.verificadaEl)}
        </Text>
      )}
      {message.avisos?.map((a, i) => (
        <Text key={i} bg="gray.50" px={2} py={1} borderRadius="md">
          {a}
        </Text>
      ))}
    </VStack>
  );
}

function Suggestions({
  botones,
  onPick,
}: {
  botones: BotonCarmen[];
  onPick: (b: BotonCarmen) => void;
}): React.ReactElement {
  return (
    <Box w="100%" pl={10}>
      <Wrap spacing={2}>
        {botones.map((b, i) => (
          <WrapItem key={i}>
            <Button size="xs" variant="outline" colorScheme="blue" onClick={() => onPick(b)}>
              {b.texto}
            </Button>
          </WrapItem>
        ))}
      </Wrap>
    </Box>
  );
}

export function CarmenChat(): React.ReactElement {
  const { messages, loading, error, sendMessage, sendBoton, clearHistory } = useCarmenChat();
  const [input, setInput] = useState('');
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  const handleSubmit = (e: React.FormEvent): void => {
    e.preventDefault();
    if (!input.trim()) return;
    void sendMessage(input);
    setInput('');
  };

  const last = messages[messages.length - 1];

  return (
    <VStack h="100%" spacing={0} align="stretch">
      <HStack px={4} py={2} borderBottomWidth="1px" justify="space-between">
        <Text fontWeight="bold">Carmen · Asistente contable</Text>
        <Button size="xs" variant="ghost" onClick={clearHistory} isDisabled={messages.length === 0}>
          Limpiar
        </Button>
      </HStack>

      <VStack flex={1} overflowY="auto" spacing={3} p={4} align="stretch">
        {messages.length === 0 && (
          <Box textAlign="center" color="gray.400" py={8} fontSize="sm">
            Hola, soy Carmen. Pregúntame por tus cobros, bancos o asientos, o por cómo se hace algo en la app.
          </Box>
        )}

        {messages.map((m) => (
          <React.Fragment key={m.id}>
            <MessageBubble message={m} />
            {m.role === 'assistant' && <Detalles message={m} />}
          </React.Fragment>
        ))}

        {!loading && last?.role === 'assistant' && last.botones && last.botones.length > 0 && (
          <Suggestions botones={last.botones} onPick={(b) => void sendBoton(b)} />
        )}

        {loading && (
          <HStack color="gray.500" fontSize="sm" pl={10}>
            <Spinner size="sm" />
            <Text>Carmen está buscando…</Text>
          </HStack>
        )}

        {error && (
          <Box bg="red.50" color="red.700" px={3} py={2} borderRadius="md" fontSize="sm">
            {error}
          </Box>
        )}

        <Box ref={endRef} />
      </VStack>

      <Box as="form" onSubmit={handleSubmit} borderTopWidth="1px" p={3}>
        <HStack>
          <Input
            placeholder="Escribe tu pregunta…"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            maxLength={500}
            aria-label="Tu pregunta para Carmen"
            isDisabled={loading}
            size="sm"
          />
          <Button type="submit" colorScheme="blue" size="sm" isLoading={loading} flexShrink={0}>
            Enviar
          </Button>
        </HStack>
        <Text fontSize="xs" color="gray.500" mt={2}>
          Carmen es un asistente automático. Las cifras salen de tu contabilidad; la IA solo responde dudas generales y no ve tus datos.
        </Text>
      </Box>
    </VStack>
  );
}
