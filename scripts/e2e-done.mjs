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

async function main() {
  const { sessionId } = await rpc('session.create', { cwd: '/tmp/dsh-notifier-e2e' })
  console.log('created session:', sessionId)

  // host 事件流：验证 running true → false（任务结束）
  const ws = new WebSocket(`ws://127.0.0.1:3080/api/events.host`)
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('等待任务结束超时（120s）')), 120000)
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data)
      const frame = msg.payload
      if (frame?.type === 'host/session-status' && frame.sessionId === sessionId) {
        console.log('host/session-status:', frame.running ? 'running' : 'IDLE ✅', new Date().toISOString())
        if (!frame.running) { clearTimeout(timer); resolve() }
      }
      if (frame?.type === 'host/agent-error' && frame.sessionId === sessionId) {
        console.log('host/agent-error:', frame.message)
      }
    })
    ws.addEventListener('error', (err) => { clearTimeout(timer); reject(err) })
  })
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', reject, { once: true })
  })
  console.log('host stream open')

  console.log('prompting...')
  await rpc('session.prompt', {
    sessionId,
    mode: 'queue',
    content: [{ type: 'text', text: '请只回复两个字：完成' }],
  })

  await done
  ws.close()
  console.log('E2E DONE-EVENT PASS:', sessionId)
  process.exit(0)
}

main().catch((err) => {
  console.error('E2E FAIL:', err)
  process.exit(1)
})
