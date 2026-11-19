import { startBallTopWatchdog } from './windows'
import { app, BrowserWindow, Menu, desktopCapturer, globalShortcut, screen, session } from 'electron'
import { settingsStore } from './store/settings'
import { historyStore } from './store/history'
import {
  createBallWindow,
  openSettingsWindow,
  preloadBubble,
  preloadMenu,
  sendBubble,
  showBallWindow,
  showBubble,
  updateHitTests
} from './windows'
import { registerIpc } from './ipc'
import { applyCustomDataDir } from './data-dir'
import { modelReady, warmupLocalAsr } from './services/local-asr'
import { startHotkey, stopHotkey } from './input/hotkey'
import { conversation } from './services/pipeline'
import { createTray } from './tray'
import { log } from './logger'

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
// 尽量走 Windows Graphics Capture（WGC）：它能抓被遮挡/独占合成的窗口，
// 比老的 GDI 抓屏更可能在"伪独占全屏"游戏里拿到画面。
app.commandLine.appendSwitch('enable-features', 'WebRtcAllowWgcScreenCapturer,WebRtcWgcScreenCapturer')
// 必须在 ready 之前：先决定 userData 放哪，再初始化任何 store
applyCustomDataDir()
app.setAppUserModelId('com.bewithu.app')

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    showBallWindow()
    openSettingsWindow()
  })

  app.whenReady().then(() => {
    boot().catch((e) => {
      log('启动失败', e)
      app.quit()
    })
  })

  app.on('window-all-closed', () => {
    app.quit()
  })

  app.on('before-quit', () => {
    try {
      conversation.stopEverything()
      stopHotkey()
    } catch (e) {
      log('退出清理失败', e)
    }
  })
}

async function boot(): Promise<void> {
  const settings = settingsStore.get()
  historyStore.load()

  Menu.setApplicationMenu(null)

  // getDisplayMedia 走 WGC：由主进程直接指定"光标所在那块屏"，不弹选择器
  session.defaultSession.setDisplayMediaRequestHandler(
    (_request, callback) => {
      desktopCapturer
        .getSources({ types: ['screen'], thumbnailSize: { width: 8, height: 8 } })
        .then((sources) => {
          if (!sources.length) {
            callback({})
            return
          }
          const cursor = screen.getCursorScreenPoint()
          const display = screen.getDisplayNearestPoint(cursor)
          const match = sources.find((s) => s.display_id === String(display.id)) ?? sources[0]
          callback({ video: match })
        })
        .catch(() => callback({}))
    },
    { useSystemPicker: false }
  )

  registerIpc(() => app.quit())
  createBallWindow()
  startBallTopWatchdog()
  preloadBubble()
  preloadMenu()
  createTray(() => app.quit())

  startHotkey(settings.voice.hotkey, (phase) => conversation.onHotkey(phase))
  log('boot: 就绪', { version: app.getVersion(), hotkey: settings.voice.hotkey })

  // 悬浮球/气泡只在"球体圆内 / 卡片内"可点，其余透明区域穿透。
  // 渲染层也会上报（见 windows.setBallHitTest），这里轮询兜底，保证任何情况下都能点。
  setInterval(() => updateHitTests(), 20)

  // 本地识别：后台预热模型，避免第一次说话多等 1.5s（闲置 5 分钟自动回收）
  if (settings.asr.mode === 'local' && modelReady()) {
    setTimeout(() => {
      void warmupLocalAsr()
        .then((ms) => log('local-asr: 启动预热完成', `${ms}ms`))
        .catch((e) => log('local-asr: 预热失败', e instanceof Error ? e.message : e))
    }, 2500)
  }

  if (!app.isPackaged) {
    globalShortcut.register('F12', () => {
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
      win?.webContents.toggleDevTools()
    })
  }

  // 第一次启动：还没配大模型时给一条引导
  if (!settings.llm.apiKey) {
    setTimeout(() => {
      showBubble()
      sendBubble({
        type: 'notice',
        notice: {
          kind: 'info',
          text: '右键我 →「设置」，填入大模型 API Key 就能开始聊天。语音识别默认在本地，首次会提示下载模型',
          action: 'open-settings'
        }
      })
    }, 1800)
  }

  if (process.env.BWU_DEMO === '1') {
    const { runDemoLoop } = await import('./demo')
    void runDemoLoop()
  }
}

process.on('uncaughtException', (e) => log('uncaughtException', e))
process.on('unhandledRejection', (e) => log('unhandledRejection', e))
