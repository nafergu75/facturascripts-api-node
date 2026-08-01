import React from 'react';
import { createRoot } from 'react-dom/client';
import { ChakraProvider } from '@chakra-ui/react';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { HelpModeProvider } from './context/HelpModeContext';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ChakraProvider>
      <HelpModeProvider>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </HelpModeProvider>
    </ChakraProvider>
  </React.StrictMode>,
);
