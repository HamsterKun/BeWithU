import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import Bubble from './Bubble'
import './bubble.css'
import { initTheme } from '../theme'

initTheme()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Bubble />
  </StrictMode>
)
