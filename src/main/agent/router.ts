/**
 * 意图路由：Agent 总开关打开时，自动把「聊天」和「要干活」分开。
 *
 * 为什么用规则而不是再调一次模型：
 * - 每条消息多一次 LLM 往返，闲聊会明显变慢；
 * - 规则可解释、可测试，误判时也容易调。
 * 规则覆盖不到的情况（模糊指令）默认走聊天，等用户说清楚再进工具循环。
 */

export type Route = 'chat' | 'task'

export interface RouteResult {
  route: Route
  /** 命中原因，写日志用 */
  reason: string
}

/** 明确要操作电脑/外部信息的说法：[正则, 权重, 说明] */
const TASK_PATTERNS: Array<[RegExp, number, string]> = [
  [/(打开|启动|运行|关掉|关闭|退出)(一下|下|个|这个|那个)?\s*(应用|程序|软件|窗口|网页|浏览器|文件|文件夹|目录)?/, 2, '开关应用/窗口'],
  [/(点击|点一下|双击|右键|按下|输入|打字|粘贴|复制|剪切|拖拽|拖动|滚动)/, 2, '键鼠操作'],
  [/(保存|另存为|导出|打印|重命名|改名|移动到|移到|删除|新建|创建|生成|整理|汇总|统计|批量)/, 2, '文件操作'],
  [/(写一?份|写个|写一个|写入|写到|改成|修改|替换|填好|填上|补上|补充)/, 2, '改写内容'],
  [/(表格|文档|演示|幻灯|excel|word|ppt|pdf|csv|markdown|报告|周报|月报)/i, 3, '办公文档'],
  [/(文件|文件夹|目录|路径|盘符|桌面|下载|安装|卸载|压缩|解压|备份|同步)/, 2, '文件系统'],
  [/(搜(索|一下|一搜)?|查(一下|查)?|查询|找(一下|找)?|最新|新闻|价格|比分|天气|汇率|股价|版本号)/, 3, '检索信息'],
  [/(定时|提醒我|闹钟|分钟(后|以后)|小时(后|以后))/, 3, '提醒/定时'],
  [/(发消息|发个消息|发邮件|发个邮件|微信|钉钉|飞书|邮件)/, 3, '发消息'],
  [/(截图|截个图|看一下这个|看下这个|瞄一眼)/, 3, '看屏幕'],
  [/(屏幕|画面|界面|窗口)/, 2, '屏幕相关'],
  [/(网页|链接|网址|浏览器|下载地址)/, 2, '网页'],
  [/(代码|脚本|命令|powershell|cmd|bash|终端|编译|部署|git\b)/i, 3, '代码/命令'],
  [/(帮我|帮忙|替我|给我)(把|将|弄|搞|处理|整理|做|写|改|查|搜|找|打开|关掉|删|复制|移动|导|发)/, 3, '请求代劳']
]

/** 明显是闲聊/情绪/身份类的说法 */
const CHAT_PATTERNS: RegExp[] = [
  /^(你好|您好|嗨|hi|hello|在吗|在不在)/i,
  /(你是谁|你叫什么|你几岁|你多大了|你会什么|你能做什么|你是什么)/,
  /(谢谢|感谢|辛苦|麻烦你了|不用了)/,
  /(晚安|早安|早上好|中午好|下午好|晚上好|睡吧|起床)/,
  /(哈哈|嘿嘿|呵呵|笑死|太逗了|无聊|好累|累了|困了|难过|不开心|郁闷|烦死了|好烦|生气|委屈)/,
  /(陪我|聊会|聊天|说说话|讲个笑话|说个笑话|讲个故事|唱个歌)/,
  /(你觉得|你怎么看|你想到|你喜欢|你讨厌|想你了|喜欢你|爱你|抱抱|亲亲|宝贝|撒娇)/,
  /(为什么|怎么会|是不是|能不能|可不可以)/,
  /^[?？!！。.…~～\s]+$/
]

/** 路径 / 文件名：几乎一定是任务 */
const PATH_PATTERN = /([A-Za-z]:\\|\\\\[^\\]+\\)|\.(docx?|xlsx?|pptx?|pdf|txt|md|csv|png|jpe?g|webp|zip|rar|7z|exe|ps1|bat|json|ya?ml)\b/i

/** 续说/确认：上一轮在干活时，这些应当继续干活 */
const FOLLOW_UP = /^(继续|然后|接着|再|还有|好了|不对|错了|改成|换成|是的|对|嗯|确认|同意|可以|不要|停|算了|重新)/

/** 只有在这个模式下，"看屏幕"类的图才有必要带上 */
export function wantsScreenReference(text: string): boolean {
  return /(看|瞧|瞄|屏幕|画面|界面|窗口|这个|这里|上面|图|截图|桌面|视频|游戏|显示|报错|弹窗|页面)/.test(text)
}

export function classifyIntent(
  text: string,
  opts: { lastWasTask?: boolean } = {}
): RouteResult {
  const t = (text || '').trim()
  if (!t) return { route: 'chat', reason: 'empty' }

  // 上一轮在跑工具，这轮的"继续/改成/好了"通常还是任务
  if (opts.lastWasTask && FOLLOW_UP.test(t)) return { route: 'task', reason: 'follow-up' }

  let taskScore = 0
  const hits: string[] = []
  for (const [re, weight, why] of TASK_PATTERNS) {
    if (re.test(t)) {
      taskScore += weight
      hits.push(why)
    }
  }
  if (PATH_PATTERN.test(t)) taskScore += 3

  let chatScore = 0
  for (const re of CHAT_PATTERNS) if (re.test(t)) chatScore += 2

  // 很短的句子且没有动作词：基本是闲聊
  if (t.length <= 8 && taskScore === 0) return { route: 'chat', reason: 'short-no-action' }

  // 明确闲聊词、且没有任何任务信号 → 聊天
  if (chatScore > 0 && taskScore === 0) return { route: 'chat', reason: 'chat-words' }

  // 任务信号足够强 → 干活
  if (taskScore >= 3) return { route: 'task', reason: hits.slice(0, 3).join('/') }

  // 有任务词但很弱、同时有闲聊词（例如"谢谢你帮我打开"）：让聊天优先，避免过度调用工具
  if (chatScore >= taskScore) return { route: 'chat', reason: 'chat-wins' }

  return { route: 'chat', reason: 'weak-task' }
}
