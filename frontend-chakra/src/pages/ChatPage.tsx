import React, { useState, useRef, useEffect } from 'react';
import {
  Box,
  Container,
  VStack,
  HStack,
  Input,
  Button,
  Heading,
  Spinner,
  Text,
} from '@chakra-ui/react';
import { ChatMessage, Message } from '../components/chat/ChatMessage';

export function ChatPage(): React.ReactElement {
  const [messages, setMessages] = useState<Message[]>([
    {
      id: '1',
      role: 'assistant',
      content: '¡Hola! Soy Carmen, tu asistente contable. ¿Cómo puedo ayudarte?',
      timestamp: new Date().toISOString(),
    },
  ]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const handleSend = async () => {
    if (!input.trim()) return;

    // Agregar mensaje del usuario
    const userMessage: Message = {
      id: Date.now().toString(),
      role: 'user',
      content: input,
      timestamp: new Date().toISOString(),
    };

    setMessages((prev) => [...prev, userMessage]);
    setInput('');
    setIsLoading(true);

    // TODO: Conectar con POST /companies/1/carmen/ask
    // Por ahora, solo simulamos una respuesta

    setTimeout(() => {
      const assistantMessage: Message = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: '(API no conectada aún)',
        timestamp: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, assistantMessage]);
      setIsLoading(false);
    }, 500);
  };

  const handleKeyPress = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <Container maxW="2xl" py={6}>
      <VStack spacing={6} align="stretch">
        <Heading as="h1" size="lg">
          💬 Carmen Asistente Contable
        </Heading>

        {/* Área de mensajes */}
        <Box
          bg="gray.50"
          borderRadius="lg"
          p={6}
          h="500px"
          overflowY="auto"
          borderWidth={1}
          borderColor="gray.200"
        >
          <VStack align="stretch" spacing={4}>
            {messages.length === 0 ? (
              <Text color="gray.500" textAlign="center">
                No hay mensajes aún.
              </Text>
            ) : (
              messages.map((msg) => <ChatMessage key={msg.id} message={msg} />)
            )}
            {isLoading && <Spinner size="sm" />}
            <div ref={messagesEndRef} />
          </VStack>
        </Box>

        {/* Input de texto */}
        <HStack spacing={2}>
          <Input
            placeholder="Escribe tu pregunta..."
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyPress={handleKeyPress}
            isDisabled={isLoading}
          />
          <Button
            colorScheme="blue"
            onClick={handleSend}
            isLoading={isLoading}
            minW="120px"
          >
            Enviar
          </Button>
        </HStack>

        <Text fontSize="xs" color="gray.500">
          💡 Carmen puede ayudarte con preguntas sobre contabilidad, impuestos e información
          de tu empresa.
        </Text>
      </VStack>
    </Container>
  );
}
