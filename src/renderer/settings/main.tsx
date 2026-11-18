import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import Settings from './Settings'
import './settings.css'
import { initTheme } from '../theme'

initTheme()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Settings />
  </StrictMode>
)
