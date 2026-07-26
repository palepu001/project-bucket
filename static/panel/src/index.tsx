import { createRoot } from 'react-dom/client';
import { view } from '@forge/bridge';
import { App } from './App';
import { Router } from './Router';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root container #root was not found');
}

view.getContext().then((context) => {
  if (context.moduleKey === 'project-bucket-router') {
    createRoot(container).render(<Router />);
  } else {
    createRoot(container).render(<App />);
  }
});
