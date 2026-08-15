import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'docs', 'screenshots')
const BASE = 'http://127.0.0.1:3080'
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const PORT = 9334
const PROFILE = '/tmp/dsh-notifier-chrome-debug'
mkdirSync(OUT, { recursive: true })
rmSync(PROFILE, { recursive: true, force: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, '--window-size=1440,900', BASE], { stdio: 'ignore' })

class Cdp {
  constructor(url) { this.ws = new WebSocket(url); this.seq = 0; this.pending = new Map() }
  async open() {
    await new Promise((res, rej) => { this.ws.addEventListener('open', res, { once: true }); this.ws.addEventListener('error', rej, { once: true }) })
    this.ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && this.pending.has(m.id)) { const p = this.pending.get(m.id); this.pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result) } })
  }
  send(method, params = {}) { const id = ++this.seq; return new Promise((res, rej) => { this.pending.set(id, { resolve: res, reject: rej }); this.ws.send(JSON.stringify({ id, method, params })) }) }
  async eval(expression) { const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text); return r.result?.value }
  async shot(file, clip) { const r = await this.send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip } : {}) }); writeFileSync(file, Buffer.from(r.data, 'base64')); console.log('shot', file) }
}

async function target() {
  for (let i = 0; i < 120; i++) { try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); const p = l.find((t) => t.type === 'page' && t.url.includes('3080')); if (p) return p } catch {} await sleep(500) }
  throw new Error('no target')
}

const t = await target()
const cdp = new Cdp(t.webSocketDebuggerUrl)
await cdp.open()
await cdp.send('Page.enable')

for (let i = 0; i < 240; i++) {
  if (await cdp.eval('typeof window.__DSH_NOTIFIER__?.demo === "function"')) break
  await sleep(500)
}
await cdp.eval(`window.__DSH_NOTIFIER__.demo('done')`)
await sleep(1200)
const info = await cdp.eval(`(() => {
  const el = document.querySelector('.dsh-notifier-toast.kind-done');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  const stack = document.querySelector('.dsh-notifier-stack');
  const sr = stack.getBoundingClientRect();
  const top = document.elementFromPoint(Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2));
  return {
    toast: { x: r.x, y: r.y, w: r.width, h: r.height, position: cs.position, opacity: cs.opacity, zIndex: cs.zIndex, display: cs.display, visibility: cs.visibility },
    stack: { x: sr.x, y: sr.y, w: sr.width, h: sr.height },
    text: el.innerText,
    innerW: window.innerWidth, innerH: window.innerHeight,
    dpr: window.devicePixelRatio,
    elementAtCenter: top?.className || top?.tagName,
    ancestors: (() => { const out=[]; let n=el; while(n){const c=getComputedStyle(n); if(c.transform!=='none'||c.contain!=='none'||c.filter!=='none') out.push(n.className+':transform='+c.transform+':contain='+c.contain+':filter='+c.filter); n=n.parentElement;} return out })()
  };
})()`)
console.log(JSON.stringify(info, null, 2))
await cdp.shot(join(OUT, 'debug-full.png'))
if (info) {
  const pad = 20
  await cdp.shot(join(OUT, 'debug-clip.png'), { x: Math.max(0, info.toast.x - pad), y: Math.max(0, info.toast.y - pad), width: info.toast.w + pad * 2, height: info.toast.h + pad * 2, scale: 2 })
}
chrome.kill('SIGKILL')
process.exit(0)
