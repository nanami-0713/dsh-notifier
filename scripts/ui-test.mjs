/**
 * UI 验收：Headless Chrome + CDP 打开真实 DSH web 页面，
 * 用真实 host API 触发 任务结束/审批/提问 三类事件，
 * 轮询 .dsh-notifier-toast DOM，出现即 Page.captureScreenshot 截图。
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
/** 测试截图写入不入库的临时目录；仓库只保留 docs/screenshots/native 一套正式图。 */
const SCREENSHOT_DIR = join(ROOT, '.artifacts', 'ui')
const BASE = 'http://127.0.0.1:3080'
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const PORT = 9333
const USER_DATA = '/tmp/dsh-notifier-chrome-profile'

mkdirSync(SCREENSHOT_DIR, { recursive: true })
rmSync(USER_DATA, { recursive: true, force: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function rpc(method, payload) {
  const res = await fetch(`${BASE}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload }),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} HTTP ${res.status}: ${text}`)
  const body = JSON.parse(text)
  if (body.result?.error) throw new Error(`${method} RPC error: ${JSON.stringify(body.result.error)}`)
  return body.result?.value ?? body.result
}

async function respondTo(rpcId, value) {
  const res = await fetch(`${BASE}/api/respond`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-response', rpcId, result: { ok: true, value } }),
  })
  if (!res.ok) throw new Error(`respond HTTP ${res.status}`)
  return res.json()
}

/** 等待某 mux 帧并返回 {rpcId, frame} */
function waitMuxFrame(sessionId, type, timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:3080/api/events.mux`)
    const timer = setTimeout(() => {
      try { ws.close() } catch {}
      reject(new Error(`等待 ${type} 超时（${timeoutMs}ms）`))
    }, timeoutMs)
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data)
      const frame = msg.payload
      if (frame?.sessionId === sessionId && frame.type === type) {
        clearTimeout(timer)
        ws.close()
        resolve({ rpcId: msg.rpcId, frame })
      }
    })
    ws.addEventListener('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    ws.addEventListener('open', () => console.log(`  [mux] 监听 ${sessionId} 的 ${type}`))
  })
}

/* ─────────── CDP ─────────── */
class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url)
    this.seq = 0
    this.pending = new Map()
  }
  async open() {
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true })
      this.ws.addEventListener('error', reject, { once: true })
    })
    this.ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data)
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) reject(new Error(JSON.stringify(msg.error)))
        else resolve(msg.result)
      }
    })
  }
  send(method, params = {}) {
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  async eval(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    if (result.exceptionDetails) throw new Error(`evaluate 失败: ${result.exceptionDetails.text}`)
    return result.result?.value
  }
  async screenshot(file, clip) {
    const result = await this.send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip } : {}) })
    writeFileSync(file, Buffer.from(result.data, 'base64'))
    console.log(`  📸 ${file}`)
  }
  close() { this.ws.close() }
}

async function waitTarget() {
  for (let i = 0; i < 120; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const page = list.find((t) => t.type === 'page' && t.url.includes('127.0.0.1:3080'))
      if (page) return page
    } catch {}
    await sleep(500)
  }
  throw new Error('Chrome 页面目标未出现')
}

async function waitSelector(cdp, selector, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const ok = await cdp.eval(`!!document.querySelector(${JSON.stringify(selector)})`)
    if (ok) return
    await sleep(300)
  }
  throw new Error(`等待 ${selector} 超时`)
}

async function waitSelectorGone(cdp, selector, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const ok = await cdp.eval(`!!document.querySelector(${JSON.stringify(selector)})`)
    if (!ok) return
    await sleep(300)
  }
  throw new Error(`等待 ${selector} 消失超时`)
}

/** 只截弹窗本体（局部 clip），避免把工作区文件树等本地信息截进公开截图。 */
async function captureToastClip(cdp, selector, file) {
  const rect = await cdp.eval(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.x, y: r.y, width: r.width, height: r.height }
  })()`)
  if (!rect) throw new Error(`截图目标不存在: ${selector}`)
  const pad = 18
  await cdp.screenshot(file, {
    x: Math.max(0, rect.x - pad),
    y: Math.max(0, rect.y - pad),
    width: rect.width + pad * 2,
    height: rect.height + pad * 2,
    scale: 2,
  })
}

/* ─────────── 主流程 ─────────── */
const chrome = spawn(CHROME, [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${USER_DATA}`,
  '--window-size=1440,900',
  BASE,
], { stdio: 'ignore' })

const cleanup = () => { try { chrome.kill('SIGKILL') } catch {} }

try {
  console.log('1. 启动 Headless Chrome')
  const target = await waitTarget()
  const cdp = new Cdp(target.webSocketDebuggerUrl)
  await cdp.open()
  await cdp.send('Page.enable')

  console.log('2. 等待 DSH 页面加载 + 插件挂载')
  await waitSelector(cdp, '.dsh-notifier-stack', 120000)
  const hook = await cdp.eval('typeof window.__DSH_NOTIFIER__?.demo')
  if (hook !== 'function') throw new Error('window.__DSH_NOTIFIER__.demo 未就绪')
  console.log('   ✓ 插件已挂载，demo hook 就绪')

  console.log('3. 真实事件：任务结束 → kind-done toast')
  {
    const { sessionId } = await rpc('session.create', { cwd: '/tmp/dsh-notifier-e2e' })
    await rpc('session.prompt', {
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: '请只回复两个字：完成' }],
    })
    console.log(`   [done] 会话 ${sessionId} 已派发任务`)
    await waitSelector(cdp, '.dsh-notifier-toast.kind-done', 90000)
    await sleep(900)
    await captureToastClip(cdp, '.dsh-notifier-toast.kind-done', join(SCREENSHOT_DIR, '01-task-done.png'))
    console.log('   ✓ 任务结束弹窗出现并截图')
  }

  console.log('4. 真实事件：权限审批 → kind-approval toast（停留，截完图后拒绝）')
  {
    const { sessionId } = await rpc('session.create', { cwd: '/tmp/dsh-notifier-e2e' })
    const watcher = waitMuxFrame(sessionId, 'approval/requested')
    await rpc('session.prompt', {
      sessionId,
      mode: 'queue',
      content: [{
        type: 'text',
        text: '请先调用 bash 工具执行命令 `touch /etc/dsh-notifier-approval-test`（这次调用预计会被沙箱拒绝）。收到拒绝结果后，立即用完全相同的命令再调用一次 bash，并携带 sandbox_permissions: "danger-full-access" 与 justification: "插件验收测试：验证审批弹窗链路"。除了这两次 bash 调用，不要做任何其他事情。',
      }],
    })
    const approval = await watcher
    console.log(`   [approval] rpcId=${approval.rpcId}`)
    await waitSelector(cdp, '.dsh-notifier-toast.kind-approval', 90000)
    await sleep(900)
    await captureToastClip(cdp, '.dsh-notifier-toast.kind-approval', join(SCREENSHOT_DIR, '02-approval-needed.png'))
    console.log('   ✓ 审批弹窗出现并截图')
    await respondTo(approval.rpcId, {
      sessionId,
      approvalId: approval.frame.approvalId,
      outcome: 'rejected',
    })
    await waitSelectorGone(cdp, '.dsh-notifier-toast.kind-approval')
    console.log('   ✓ 拒绝后审批弹窗自动消失')
  }

  console.log('5. 真实事件：用户提问 → kind-question toast（停留，截完图后回答）')
  {
    const { sessionId } = await rpc('session.create', { cwd: '/tmp/dsh-notifier-e2e' })
    const watcher = waitMuxFrame(sessionId, 'question/requested')
    await rpc('session.prompt', {
      sessionId,
      mode: 'queue',
      content: [{
        type: 'text',
        text: '请立即调用 ask_user_question 工具，向用户提出一个问题：「是否继续执行下一步？」，提供两个选项：继续执行 / 停止。除了调用这个工具，不要做任何其他事情。',
      }],
    })
    const question = await watcher
    console.log(`   [question] rpcId=${question.rpcId}`)
    await waitSelector(cdp, '.dsh-notifier-toast.kind-question', 90000)
    await sleep(900)
    await captureToastClip(cdp, '.dsh-notifier-toast.kind-question', join(SCREENSHOT_DIR, '03-question-needed.png'))
    console.log('   ✓ 提问弹窗出现并截图')
    const first = question.frame.questions[0]
    await respondTo(question.rpcId, {
      sessionId,
      answer: { answers: [{ id: first.id, selected: first.options ? [first.options[0].label] : [] }] },
    })
    await waitSelectorGone(cdp, '.dsh-notifier-toast.kind-question')
    console.log('   ✓ 回答后提问弹窗自动消失')
  }

  console.log('6. demo hook：任务出错样式')
  await cdp.eval(`window.__DSH_NOTIFIER__.demo('error')`)
  await waitSelector(cdp, '.dsh-notifier-toast.kind-error')
  await sleep(900)
  await captureToastClip(cdp, '.dsh-notifier-toast.kind-error', join(SCREENSHOT_DIR, '04-agent-error.png'))
  console.log('   ✓ 错误弹窗截图完成')

  console.log('UI E2E ALL PASS ✅')
} catch (error) {
  console.error('UI E2E FAIL:', error)
  process.exitCode = 1
} finally {
  cleanup()
}
