import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles/tokens.css';
import './styles/global.css';
import './styles/experience.css';

const container = document.getElementById('root');

if (!container) {
  throw new Error('Tripwire could not find the #root element to mount into.');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
