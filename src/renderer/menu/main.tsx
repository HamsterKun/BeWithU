import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import BallMenu from './BallMenu'
import './menu.css'
import { initTheme } from '../theme'

initTheme()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BallMenu />
  </StrictMode>
)
