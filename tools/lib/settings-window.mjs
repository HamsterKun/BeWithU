/* E2E 共用：按生产窗口角色拿到设置窗口
 *
 * 1.0.11 起 preload 按窗口角色最小化暴露接口：球窗只有主题订阅，设置类调用只有设置窗能用。
 * 测试不能再从球窗直接调 settings.update / settings.open，必须走用户真实路径：
 * 点球出气泡 → 气泡里打开设置页 → 在设置窗执行管理操作。
 */
export async function findPage(jget, sleep, needle, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const list = await jget('/json')
      const page = (list || []).find((x) => x.type === 'page' && x.url.includes(needle))
      if (page) return page
    } catch {}
    await sleep(200)
  }
  return null
}

export async function openSettingsWindow({ Conn, jget, sleep, ball, bubble: existingBubble, tab = 'agent' }) {
  let bubble = existingBubble
  if (!bubble) {
    let bubbleTarget = await findPage(jget, sleep, '/bubble/', 4)
    if (!bubbleTarget) {
      await ball.eval('window.bwu.ball.click(false)')
      bubbleTarget = await findPage(jget, sleep, '/bubble/')
    }
    if (!bubbleTarget) throw new Error('bubble window did not open')
    bubble = await Conn.open(bubbleTarget.webSocketDebuggerUrl)
  }
  for (let i = 0; i < 40; i++) {
    if (await bubble.eval('Boolean(window.bwu && window.bwu.settings && window.bwu.settings.open)')) break
    await sleep(200)
  }
  await bubble.eval(`window.bwu.settings.open(${JSON.stringify(tab)})`)
  const settingsTarget = await findPage(jget, sleep, '/settings/')
  if (!settingsTarget) {
    if (!existingBubble) bubble.close()
    throw new Error('settings window did not open')
  }
  const conn = await Conn.open(settingsTarget.webSocketDebuggerUrl)
  for (let i = 0; i < 40; i++) {
    if (await conn.eval('Boolean(window.bwu && window.bwu.settings)')) break
    await sleep(200)
  }
  // 页面 mount 之后才订阅 focusTab，所以再点一次标签，保证落在目标页
  await bubble.eval(`window.bwu.settings.open(${JSON.stringify(tab)})`)
  await sleep(600)
  return {
    conn,
    bubble,
    update: (patch) => conn.eval(`window.bwu.settings.update(${JSON.stringify(patch)})`),
    get: () => conn.eval('window.bwu.settings.get()'),
    close() {
      const shut = (c) => {
        try {
          if (c && typeof c.close === 'function') c.close()
          else if (c && c.ws) c.ws.close()
        } catch {}
      }
      shut(conn)
      if (!existingBubble) shut(bubble)
    }
  }
}
