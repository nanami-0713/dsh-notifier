import { randomUUID } from 'node:crypto'

const BASE = 'http://127.0.0.1:3080'

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

async function respond(message) {
  const res = await fetch(`${BASE}/api/respond`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(message),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`respond HTTP ${res.status}: ${text}`)
  return JSON.parse(text)
}

async function main() {
  const { sessionId } = await rpc('session.create', { cwd: '/tmp/dsh-notifier-e2e' })
  console.log('created session:', sessionId)

  const ws = new WebSocket(`ws://127.0.0.1:3080/api/events.mux`)
  const frames = []
  const found = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`等待 approval/requested 超时（180s），帧数=${frames.length}`)), 180000)
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data)
      const frame = msg.payload
      if (!frame || frame.sessionId !== sessionId) return
      frames.push(frame.type)
      if (frame.type === 'approval/requested') {
        clearTimeout(timer)
        resolve({ rpcId: msg.rpcId, frame })
      }
    })
    ws.addEventListener('error', (err) => { clearTimeout(timer); reject(err) })
  })
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', reject, { once: true })
  })
  console.log('mux stream open')

  await rpc('session.prompt', {
    sessionId,
    mode: 'queue',
    content: [{
      type: 'text',
      text: '请立即调用 bash 工具执行命令 `touch /tmp/dsh-notifier-approval-test`，并给该调用携带 sandbox_permissions: "danger-full-access" 与 justification: "插件验收测试：验证审批弹窗链路"。除了调用这个工具，不要做任何其他事情。',
    }],
  })
  console.log('prompting...')

  const { rpcId, frame } = await found
  console.log('APPROVAL-REQUESTED PASS ✅')
  console.log('rpcId:', rpcId)
  console.log('approvalId:', frame.approvalId)
  console.log('toolName:', frame.toolName)
  console.log('reason:', frame.reason)

  const receipt = await respond({
    type: 'client-response',
    rpcId,
    result: {
      ok: true,
      value: { sessionId, approvalId: frame.approvalId, outcome: 'rejected' },
    },
  })
  console.log('已回复 rejected:', JSON.stringify(receipt))
  ws.close()
  process.exit(0)
}

main().catch((err) => {
  console.error('E2E FAIL:', err)
  process.exit(1)
})
