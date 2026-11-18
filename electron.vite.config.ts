import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

const r = (...p: string[]): string => resolve(__dirname, ...p)

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: r('src/main/index.ts'),
          'asr-worker': r('src/main/asr-worker.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: r('src/preload/index.ts') }
      }
    }
  },
  renderer: {
    root: r('src/renderer'),
    plugins: [react()],
    resolve: {
      alias: {
        '@shared': r('src/shared')
      }
    },
    build: {
      rollupOptions: {
        input: {
          ball: r('src/renderer/ball/index.html'),
          bubble: r('src/renderer/bubble/index.html'),
          menu: r('src/renderer/menu/index.html'),
          settings: r('src/renderer/settings/index.html')
        }
      }
    }
  }
})
