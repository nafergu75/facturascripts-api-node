/**
 * Panel de chat de Carmen: mensajes, fuentes citadas, sugerencias e input.
 * Componentes hijos inline para mantener el modulo compacto.
 */

import React, { useEffect, useRef, useState } from 'react';
import {
  Avatar,
  Box,
  Button,
  HStack,
  Input,
  Spinner,
  Text,
  VStack,
  Wrap,
  WrapItem,
} from '@chakra-ui/react';
import { useCarmenChat, ChatMessage } from '../../hooks/useCarmenChat';
import { ChatSource } from '../../api/carmenApi';

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
        {message.content}
      </Box>
    </HStack>
  );
}

function Sources({ sources }: { sources: ChatSource[] }): React.ReactElement {
  return (
    <Box w="100%" pl={10}>
      <Text fontSize="xs" fontWeight="bold" color="gray.500" mb={1}>
        📚 Fuentes
      </Text>
      <VStack align="flex-start" spacing={1}>
        {sources.map((s, i) => (
          <Box key={`${s.source}-${i}`} fontSize="xs" color="gray.600">
            <Text as="span" fontWeight="semibold" color="blue.600">
              {s.title}
            </Text>{' '}
            <Text as="span" color="gray.400">
              ({s.source})
            </Text>
          </Box>
        ))}
      </VStack>
    </Box>
  );
}

function Suggestions({
  suggestions,
  onPick,
}: {
  suggestions: string[];
  onPick: (s: string) => void;
}): React.ReactElement {
  return (
    <Box w="100%" pl={10}>
      <Wrap spacing={2}>
        {suggestions.map((s, i) => (
          <WrapItem key={i}>
            <Button size="xs" variant="outline" colorScheme="blue" onClick={() => onPick(s)}>
              {s}
            </Button>
          </WrapItem>
        ))}
      </Wrap>
    </Box>
  );
}

export function CarmenChat(): React.ReactElement {
  const { messages, loading, error, sendMessage, clearHistory } = useCarmenChat();
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
        <Text fontWeight="bold">👩‍💼 Carmen · Asistente contable</Text>
        <Button size="xs" variant="ghost" onClick={clearHistory} isDisabled={messages.length === 0}>
          Limpiar
        </Button>
      </HStack>

      <VStack flex={1} overflowY="auto" spacing={3} p={4} align="stretch">
        {messages.length === 0 && (
          <Box textAlign="center" color="gray.400" py={8} fontSize="sm">
            Hola, soy Carmen 👋 Pregúntame sobre IVA, IRPF, asientos, facturas o los modelos de Hacienda.
          </Box>
        )}

        {messages.map((m) => (
          <React.Fragment key={m.id}>
            <MessageBubble message={m} />
            {m.role === 'assistant' && m.sources && m.sources.length > 0 && <Sources sources={m.sources} />}
          </React.Fragment>
        ))}

        {!loading && last?.role === 'assistant' && last.suggestions && last.suggestions.length > 0 && (
          <Suggestions suggestions={last.suggestions} onPick={(s) => void sendMessage(s)} />
        )}

        {loading && (
          <HStack color="gray.500" fontSize="sm" pl={10}>
            <Spinner size="sm" />
            <Text>Carmen está pensando…</Text>
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
            isDisabled={loading}
            size="sm"
          />
          <Button type="submit" colorScheme="blue" size="sm" isLoading={loading} flexShrink={0}>
            Enviar
          </Button>
        </HStack>
      </Box>
    </VStack>
  );
}
