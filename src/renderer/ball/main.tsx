import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import Ball from './Ball'
import './ball.css'
import { initTheme } from '../theme'

initTheme()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Ball />
  </StrictMode>
)
