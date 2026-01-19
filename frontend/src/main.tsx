import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { initCornerstone } from './utils/cornerstoneInit'
import { initStoragePersistence } from './db/db'

// Initialize services
initCornerstone();
initStoragePersistence();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
