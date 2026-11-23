import { createRoot } from 'react-dom/client';
import { CssBaseline } from '@mui/material';
import App from './App';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('Missing mobile root element');

createRoot(container).render(
  <>
    <CssBaseline />
    <App />
  </>,
);
