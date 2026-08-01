import React from 'react';
import { Box, Text, HStack, Avatar } from '@chakra-ui/react';

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

interface ChatMessageProps {
  message: Message;
}

export function ChatMessage({ message }: ChatMessageProps): React.ReactElement {
  const isUser = message.role === 'user';

  return (
    <HStack align="flex-start" spacing={3} mb={4} justify={isUser ? 'flex-end' : 'flex-start'}>
      {!isUser && <Avatar name="Carmen" size="sm" />}
      <Box
        bg={isUser ? 'blue.500' : 'gray.100'}
        color={isUser ? 'white' : 'black'}
        px={4}
        py={2}
        borderRadius="lg"
        maxW="70%"
      >
        <Text fontSize="sm">{message.content}</Text>
        <Text fontSize="xs" opacity={0.7} mt={1}>
          {new Date(message.timestamp).toLocaleTimeString()}
        </Text>
      </Box>
      {isUser && <Avatar name="Tu" size="sm" />}
    </HStack>
  );
}
