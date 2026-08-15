/**
 * @dsh-external/dsh-notifier — client half（web toast 弹窗）。
 *
 * 挂在官方 `shell.overlay` 槽位（list slot，可叠加、不遮挡应用），订阅
 * DSH 的两条实时事件流：
 * - host 流（events.host）：`host/session-status` running→idle 边沿 = 任务结束；
 *   `host/agent-error` = 任务出错。
 * - mux 流（events.mux）：`approval/requested`（权限审批）与
 *   `question/requested`（用户提问）= 运行中需要用户决策。
 *
 * 结束/错误 toast 自动消失；决策 toast 保持钉住，直到被回答/解决或手动关闭。
 * 点卡片会打开对应会话。另暴露 window.__DSH_NOTIFIER__（含 demo）便于验收。
 */
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ConnectionHandle, HostFrame, MuxFrame } from '@deepseek-ai/dsh-client-connection/client'

type ToastKind = 'done' | 'approval' | 'question' | 'error'

interface Toast {
  /** DOM key：baseKey + 递增序号 */
  key: string
  /** 稳定去重键，例如 approval:<id> / question:<rpcId> */
  baseKey: string
  kind: ToastKind
  sessionId?: string
  title: string
  body: string
  sticky: boolean
  createdAt: number
}

interface SessionListSnapshot {
  byId?: Record<string, {
    projectionValues?: { title?: string | null }
    cwd?: string
  }>
}

interface ClientContext {
  effect(fn: () => (() => void) | void, label?: string): void
  connection: ConnectionHandle
  sessions: {
    list: { getSnapshot(): SessionListSnapshot }
    open(id: string): void
  }
  slots: {
    inject(slot: string, factory: () => unknown): unknown
    register(options: { name: string; id: string; order?: number }, component: unknown): unknown
  }
}

export const inject = ['connection', 'sessions', 'slots']

/* ─────────────────────────────── 工具函数 ─────────────────────────────── */

function shortId(id: string): string {
  return id.length > 12 ? id.slice(0, 12) : id
}

function fmtTime(ms: number): string {
  try {
    return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  } catch {
    return ''
  }
}

let audioContext: AudioContext | undefined

/** 短促提示音（WebAudio，失败静默）。首次播放若被浏览器挂起则尝试 resume。 */
function chime(): void {
  try {
    const AudioCtor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AudioCtor) return
    audioContext ??= new AudioCtor()
    const ac = audioContext
    if (ac.state === 'suspended') void ac.resume()
    const now = ac.currentTime
    const gain = ac.createGain()
    gain.gain.setValueAtTime(0.0001, now)
    gain.gain.exponentialRampToValueAtTime(0.12, now + 0.02)
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.5)
    gain.connect(ac.destination)
    const osc = ac.createOscillator()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(880, now)
    osc.frequency.exponentialRampToValueAtTime(1244, now + 0.18)
    osc.connect(gain)
    osc.start(now)
    osc.stop(now + 0.5)
  } catch {
    /* 音频不可用就安静地失败 */
  }
}

const CSS = `
.dsh-notifier-stack{position:fixed;right:18px;bottom:18px;z-index:2147483000;display:flex;flex-direction:column;gap:10px;width:min(380px,calc(100vw - 36px));pointer-events:none;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif}
.dsh-notifier-toast{pointer-events:auto;position:relative;display:flex;gap:10px;align-items:flex-start;padding:12px 14px;border-radius:14px;background:rgba(17,24,39,.96);border:1px solid rgba(148,163,184,.28);color:#E5E7EB;box-shadow:0 16px 40px rgba(2,6,23,.45);backdrop-filter:blur(10px);animation:dsh-notifier-in .22s cubic-bezier(.2,.9,.3,1.2)}
.dsh-notifier-toast.leaving{animation:dsh-notifier-out .18s ease forwards}
.dsh-notifier-toast::before{content:"";position:absolute;left:0;top:12px;bottom:12px;width:3px;border-radius:99px;background:#34D399}
.dsh-notifier-toast.kind-approval::before,.dsh-notifier-toast.kind-question::before{background:#FBBF24}
.dsh-notifier-toast.kind-error::before{background:#F87171}
.dsh-notifier-toast.kind-question::before{background:#60A5FA}
.dsh-notifier-icon{flex:none;width:22px;height:22px;display:grid;place-items:center;font-size:15px;line-height:1}
.dsh-notifier-main{min-width:0;flex:1;display:flex;flex-direction:column;gap:3px}
.dsh-notifier-title{margin:0;font-size:13px;font-weight:650;line-height:18px;color:#F9FAFB;display:flex;align-items:center;gap:6px}
.dsh-notifier-body{margin:0;font-size:12px;line-height:17px;color:#9CA3AF;word-break:break-word;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.dsh-notifier-meta{font-size:10px;color:#6B7280;font-variant-numeric:tabular-nums}
.dsh-notifier-actions{display:flex;gap:6px;margin-top:6px}
.dsh-notifier-btn{font:inherit;font-size:12px;line-height:18px;padding:4px 10px;border-radius:8px;border:1px solid rgba(148,163,184,.35);background:rgba(255,255,255,.06);color:#E5E7EB;cursor:pointer}
.dsh-notifier-btn:hover{background:rgba(255,255,255,.12)}
.dsh-notifier-btn.primary{background:#4D6BFE;border-color:#4D6BFE;color:#fff}
.dsh-notifier-btn.primary:hover{background:#5B76FF}
.dsh-notifier-close{flex:none;width:20px;height:20px;border:none;background:transparent;color:#9CA3AF;font-size:15px;line-height:1;cursor:pointer;border-radius:6px;padding:0}
.dsh-notifier-close:hover{color:#F9FAFB;background:rgba(255,255,255,.08)}
@keyframes dsh-notifier-in{from{opacity:0;transform:translateY(14px) scale(.97)}to{opacity:1;transform:none}}
@keyframes dsh-notifier-out{to{opacity:0;transform:translateY(10px) scale(.97)}}
`

const KIND_ICON: Record<ToastKind, string> = {
  done: '✅',
  approval: '⚠️',
  question: '❓',
  error: '❌',
}

/* ─────────────────────────────── 组件 ─────────────────────────────── */

function makeOverlayComponent(ctx: ClientContext) {
  return function NotifierOverlay() {
    const [toasts, setToasts] = useState<Toast[]>([])
    const ctxRef = useRef(ctx)
    ctxRef.current = ctx
    const timersRef = useRef(new Map<string, number>())
    const sequenceRef = useRef(0)

    const dismiss = (key: string) => {
      const timer = timersRef.current.get(key)
      if (timer !== undefined) {
        window.clearTimeout(timer)
        timersRef.current.delete(key)
      }
      setToasts((prev) => prev.filter((toast) => toast.key !== key))
    }

    const dismissBase = (baseKey: string) => {
      setToasts((prev) => {
        for (const toast of prev) {
          if (toast.baseKey !== baseKey) continue
          const timer = timersRef.current.get(toast.key)
          if (timer !== undefined) {
            window.clearTimeout(timer)
            timersRef.current.delete(toast.key)
          }
        }
        return prev.filter((toast) => toast.baseKey !== baseKey)
      })
    }

    useEffect(() => {
      const controller = new AbortController()
      const { signal } = controller
      const api = ctxRef.current.connection.api
      const running = new Map<string, boolean>()

      const sessionTitle = (sessionId: string): string | undefined => {
        const snapshot = ctxRef.current.sessions.list.getSnapshot()
        const row = snapshot.byId?.[sessionId]
        const title = row?.projectionValues?.title
        if (title) return title
        return row?.cwd
      }

      const push = (toast: Omit<Toast, 'key' | 'createdAt'>): void => {
        sequenceRef.current += 1
        const key = `${toast.baseKey}:${sequenceRef.current}`
        const full: Toast = { ...toast, key, createdAt: Date.now() }
        setToasts((prev) => [full, ...prev].slice(0, 6))
        chime()
        if (!full.sticky) {
          const ttl = full.kind === 'error' ? 10000 : 6000
          const timer = window.setTimeout(() => dismiss(full.key), ttl)
          timersRef.current.set(full.key, timer)
        }
      }

      const pushDone = (sessionId: string, reason: 'done' | 'error', message?: string) => {
        const title = sessionTitle(sessionId)
        const context = title ? `「${title}」` : `会话 ${shortId(sessionId)}`
        if (reason === 'error') {
          push({
            baseKey: `error:${sessionId}:${Date.now()}`,
            kind: 'error',
            sessionId,
            title: 'DSH 任务出错',
            body: `${context}：${message ?? '未知错误'}`,
            sticky: false,
          })
          return
        }
        push({
          baseKey: `done:${sessionId}`,
          kind: 'done',
          sessionId,
          title: 'DSH 任务完成',
          body: `${context} 已运行结束，点我查看结果。`,
          sticky: false,
        })
      }

      const pushDecision = (
        kind: 'approval' | 'question',
        baseKey: string,
        sessionId: string,
        title: string,
        body: string,
      ) => {
        push({ baseKey, kind, sessionId, title, body, sticky: true })
      }

      const sleep = (ms: number) => new Promise<void>((resolve) => {
        const timer = window.setTimeout(resolve, ms)
        signal.addEventListener('abort', () => window.clearTimeout(timer), { once: true })
      })

      const hostLoop = async (): Promise<void> => {
        while (!signal.aborted) {
          try {
            for await (const envelope of api.events.host({}, signal)) {
              const frame = envelope.payload
              if (frame.type === 'host/session-status') {
                const previous = running.get(frame.sessionId)
                if (previous === undefined) {
                  running.set(frame.sessionId, frame.running)
                } else if (previous && !frame.running) {
                  running.set(frame.sessionId, false)
                  pushDone(frame.sessionId, 'done')
                } else if (!previous && frame.running) {
                  running.set(frame.sessionId, true)
                }
              } else if (frame.type === 'host/agent-error') {
                pushDone(frame.sessionId, 'error', frame.message)
              }
            }
            return
          } catch (error) {
            if (signal.aborted) return
            console.warn('[dsh-notifier] host 事件流断开，1.5s 后重连', error)
            await sleep(1500)
          }
        }
      }

      const muxLoop = async (): Promise<void> => {
        while (!signal.aborted) {
          try {
            for await (const envelope of api.events.mux({}, signal)) {
              const frame = envelope.payload
              if (frame.type === 'approval/requested') {
                const title = sessionTitle(frame.sessionId)
                const context = title ? `「${title}」` : `会话 ${shortId(frame.sessionId)}`
                const tool = frame.toolName || '一个工具'
                pushDecision(
                  'approval',
                  `approval:${frame.approvalId}`,
                  frame.sessionId,
                  'DSH 需要你的批准',
                  `${context} 请求执行「${tool}」${frame.reason ? `：${frame.reason}` : ''}`,
                )
              } else if (frame.type === 'approval/resolved') {
                dismissBase(`approval:${frame.approvalId}`)
              } else if (frame.type === 'question/requested') {
                const title = sessionTitle(frame.sessionId)
                const context = title ? `「${title}」` : `会话 ${shortId(frame.sessionId)}`
                const first = frame.questions[0]
                const summary = first
                  ? (first.header ? `${first.header}：` : '') + first.question
                  : '收到一组问题'
                pushDecision(
                  'question',
                  `question:${envelope.rpcId}`,
                  frame.sessionId,
                  'DSH 需要你回答',
                  `${context} ${summary}${frame.questions.length > 1 ? `（共 ${frame.questions.length} 个问题）` : ''}`,
                )
              } else if (frame.type === 'question/resolved') {
                dismissBase(`question:${frame.questionRpcId}`)
              }
            }
            return
          } catch (error) {
            if (signal.aborted) return
            console.warn('[dsh-notifier] mux 事件流断开，1.5s 后重连', error)
            await sleep(1500)
          }
        }
      }

      void hostLoop()
      void muxLoop()

      // 调试/验收入口：window.__DSH_NOTIFIER__.demo('done' | 'approval' | 'question' | 'error')
      ;(window as unknown as {
        __DSH_NOTIFIER__?: { demo(kind: ToastKind): void }
      }).__DSH_NOTIFIER__ = {
        demo(kind) {
          const sessionId = 'demo-session'
          if (kind === 'done') pushDone(sessionId, 'done')
          else if (kind === 'error') pushDone(sessionId, 'error', '演示：任务失败')
          else if (kind === 'approval') {
            pushDecision('approval', `approval:demo:${Date.now()}`, sessionId, 'DSH 需要你的批准', '演示会话 请求执行「bash」：需要扩大沙箱权限')
          } else {
            pushDecision('question', `question:demo:${Date.now()}`, sessionId, 'DSH 需要你回答', '演示会话 是否继续执行下一步计划？')
          }
        },
      }

      return () => {
        controller.abort()
        for (const timer of timersRef.current.values()) window.clearTimeout(timer)
        timersRef.current.clear()
        delete (window as unknown as { __DSH_NOTIFIER__?: unknown }).__DSH_NOTIFIER__
      }
    }, [])

    const openSession = (toast: Toast) => {
      if (!toast.sessionId || toast.sessionId === 'demo-session') return
      try {
        ctxRef.current.sessions.open(toast.sessionId)
      } catch (error) {
        console.warn('[dsh-notifier] 打开会话失败', error)
      }
    }

    return createPortal(
      <div className="dsh-notifier-stack" role="status" aria-live="polite">
        {toasts.map((toast) => (
          <div
            key={toast.key}
            className={`dsh-notifier-toast kind-${toast.kind}`}
            onClick={() => openSession(toast)}
          >
            <span className="dsh-notifier-icon" aria-hidden="true">{KIND_ICON[toast.kind]}</span>
            <div className="dsh-notifier-main">
              <p className="dsh-notifier-title">
                {toast.title}
                <span className="dsh-notifier-meta">{fmtTime(toast.createdAt)}</span>
              </p>
              <p className="dsh-notifier-body">{toast.body}</p>
              <div className="dsh-notifier-actions">
                <button
                  type="button"
                  className="dsh-notifier-btn primary"
                  onClick={(event) => {
                    event.stopPropagation()
                    openSession(toast)
                  }}
                >
                  {toast.kind === 'done' ? '查看会话' : '去处理'}
                </button>
                <button
                  type="button"
                  className="dsh-notifier-btn"
                  onClick={(event) => {
                    event.stopPropagation()
                    dismiss(toast.key)
                  }}
                >
                  知道了
                </button>
              </div>
            </div>
            <button
              type="button"
              className="dsh-notifier-close"
              aria-label="关闭"
              onClick={(event) => {
                event.stopPropagation()
                dismiss(toast.key)
              }}
            >
              ✕
            </button>
          </div>
        ))}
      </div>,
      document.body,
    )
  }
}

/* ─────────────────────────────── 插件入口 ─────────────────────────────── */

export function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    // 注入 <style>：slot 重挂载时由 effect 清理，避免样式重复。
    const style = document.createElement('style')
    style.id = '@dsh-external/dsh-notifier-style'
    style.textContent = CSS
    document.head.appendChild(style)

    const dispose = ctx.slots.inject('shell.overlay', () =>
      ctx.slots.register(
        {
          name: 'shell.overlay',
          id: '@dsh-external/dsh-notifier-overlay',
          order: 80,
        },
        makeOverlayComponent(ctx),
      ),
    )

    return () => {
      if (typeof dispose === 'function') (dispose as () => void)()
      style.remove()
    }
  }, '@dsh-external/dsh-notifier: overlay')
}
