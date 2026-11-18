import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import BallMenu from './BallMenu'
import './menu.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BallMenu />
  </StrictMode>
)
