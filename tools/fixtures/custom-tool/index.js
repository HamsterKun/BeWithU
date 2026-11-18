// 测试用的自定义工具：验证 manifest 解析、信任门禁、子进程执行与 api 代理
module.exports = {
  async run(args, api) {
    const name = String(args.name || '朋友')
    await api.log('greet tool: ' + name)
    return { ok: true, summary: `你好，${name}！（来自自定义工具）`, data: { name } }
  }
}
