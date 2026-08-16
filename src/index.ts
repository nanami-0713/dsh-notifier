/**
 * @dsh-external/dsh-notifier — host half（系统级提醒，相当于 Claude Code 的 Hook）。
 *
 * 监听 DSH 运行时事件，在「任务结束」「需要用户决策（审批/提问）」「任务出错」时：
 *   1. 拉起跨窗口可见的 always-on-top 悬浮面板（macOS 用自带 Swift notifier，
 *      NSPanel .floating + canJoinAllSpaces：浮在所有应用之上、所有 Space/全屏可见；
 *      Linux/Windows 尽力回退到 zenity / MessageBox）；
 *   2. 同时发一条系统通知中心横幅（可配置关闭）；
 *   3. 写插件日志（~/.dsh/super-injector/dsh-notifier.log）。
 *
 * 观察的事件：
 * - agent/status: running → idle 边沿 = 一次任务结束
 * - session/event: approval/asked = 权限审批询问
 * - session/event: tool/call(ask_user_question) = 用户提问
 * - approval/request waterfall = 审批观察面的辅助路径（不劫持 answerer 链）
 * - agent/error: 无 turn 位置的 agent 失败
 *
 * web 内的 toast 弹窗由 client half（src/client）负责，两者相互独立。
 */
import { execFile, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import {
  CONFIG_API_PATH,
  DEFAULT_SETTINGS,
  canonicalPresetId,
  normalizeSettings,
  presetById,
  type NotifierSettings,
} from './shared.js'

export const name = '@dsh-external/dsh-notifier'
export const inject = []

export interface NotifierConfig {
  /** 系统通知中心横幅（默认 true） */
  desktop?: boolean
  /** 跨窗口悬浮面板（默认 true） */
  floating?: boolean
  /** 悬浮面板「去处理/查看会话」按钮打开的 DSH 地址（默认 $DSH_WEB_URL 或 http://127.0.0.1:3080） */
  webUrl?: string
  /** 同一事件的最短重复提醒间隔，秒（默认 8） */
  quietSeconds?: number
}

interface AgentLike {
  readonly id: string
}

interface AgentStatusPayload {
  agent: AgentLike
  status: 'idle' | 'running'
}

interface ApprovalRequestPayload {
  agent: AgentLike
  toolName?: string
  reason?: string
  signal?: AbortSignal
}

interface AgentErrorPayload {
  agent: AgentLike
  error: unknown
}

interface SessionLike {
  readonly id: string
}

interface SessionEventLike {
  type: string
  data?: {
    id?: string
    toolName?: string
    callId?: string
    reason?: string
    name?: string
    message?: {
      source?: {
        callId?: string
      }
    }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    'agent/status'(payload: AgentStatusPayload): void
    'approval/request'(req: ApprovalRequestPayload, next: () => Promise<unknown>): Promise<unknown>
    'agent/error'(payload: AgentErrorPayload): void
    'session/event'(session: SessionLike, event: SessionEventLike): void
  }
}

type NotifyKind = 'done' | 'approval' | 'question' | 'error'

interface FloatingOptions {
  sticky: boolean
  primaryLabel: string
  /** 决策面板的稳定 key；对应决策解决时自动关闭（approval:<id> / question:<callId>） */
  panelKey?: string
}

const DEFAULTS: Required<Omit<NotifierConfig, 'webUrl'>> & { webUrl: string } = {
  desktop: true,
  floating: true,
  webUrl: process.env.DSH_WEB_URL || 'http://127.0.0.1:3080',
  quietSeconds: 8,
}

/** 合并顺序：内置默认 → loader 旧配置（部署默认）→ 用户选择的预设 → 用户显式覆盖字段。 */
function resolveSettings(rawBase: NotifierConfig, userInput: unknown): NotifierSettings {
  const root = typeof userInput === 'object' && userInput !== null && !Array.isArray(userInput)
    ? userInput as Record<string, unknown>
    : {}
  const requestedPreset = root.preset === undefined ? 'default' : String(root.preset)
  const preset = presetById(requestedPreset) ?? presetById('default')!

  const legacy = {
    floating: rawBase.floating ?? DEFAULT_SETTINGS.floating,
    desktop: rawBase.desktop ?? DEFAULT_SETTINGS.desktop,
    quietSeconds: rawBase.quietSeconds ?? DEFAULT_SETTINGS.quietSeconds,
    webUrl: rawBase.webUrl ?? DEFAULT_SETTINGS.webUrl,
  }

  const merged: NotifierSettings = normalizeSettings({
    ...legacy,
    ...preset.settings,
    preset: preset.id,
    // 用户显式写过的字段最后覆盖预设
    ...(root.toast !== undefined ? { toast: root.toast } : {}),
    ...(root.floating !== undefined ? { floating: root.floating } : {}),
    ...(root.desktop !== undefined ? { desktop: root.desktop } : {}),
    ...(root.quietSeconds !== undefined ? { quietSeconds: root.quietSeconds } : {}),
    ...(root.webUrl !== undefined ? { webUrl: root.webUrl } : {}),
  })

  // 只有显式改过行为字段才重新判定指纹；只选 preset（或只改 webUrl）时保留请求的预设 id。
  const hasOverrides =
    root.toast !== undefined ||
    root.floating !== undefined ||
    root.desktop !== undefined ||
    root.quietSeconds !== undefined
  merged.preset = hasOverrides
    ? canonicalPresetId(merged)
    : (presetById(requestedPreset) === undefined ? 'custom' : requestedPreset)
  return merged
}

const KIND_SOUND: Record<NotifyKind, string> = {
  done: 'Glass',
  approval: 'Ping',
  question: 'Ping',
  error: 'Basso',
}

function shortId(id: string): string {
  return id.length > 12 ? id.slice(0, 12) : id
}

function appleScriptString(text: string): string {
  return JSON.stringify(String(text).replace(/[\r\n]+/g, ' '))
}

/** POSIX sh 单引号转义（Linux zenity/xdg-open 使用）。 */
function shellQuote(text: string): string {
  return `'${String(text).replace(/'/g, `'\\''`)}'`
}

/** PowerShell 单引号字符串转义。 */
function psString(text: string): string {
  return `'${String(text).replace(/'/g, "''")}'`
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error).slice(0, 200)
}

const MAX_CONFIG_BODY_BYTES = 64 * 1024

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('配置请求体超过 64KB 上限'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

export function apply(ctx: Context, raw: NotifierConfig = {}): void {
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  const logFile = join(dshHome, 'super-injector', 'dsh-notifier.log')
  const notifierDir = join(dshHome, 'plugins', 'dsh-notifier')
  const configFile = join(notifierDir, 'config.json')
  const readUserConfig = (): unknown => {
    try {
      return JSON.parse(readFileSync(configFile, 'utf8'))
    } catch {
      return {}
    }
  }
  const saveUserConfig = (settings: NotifierSettings): void => {
    mkdirSync(notifierDir, { recursive: true })
    writeFileSync(configFile, JSON.stringify(settings, null, 2) + '\n', 'utf8')
  }
  let config = resolveSettings(raw, readUserConfig())

  ctx.inject(['webServer'], (httpCtx) => {
    const web = (httpCtx as typeof httpCtx & {
      webServer: { register: (route: {
        kind: 'exact'
        path: string
        handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
      }) => () => void }
    }).webServer
    httpCtx.effect(() => web.register({
      kind: 'exact',
      path: CONFIG_API_PATH,
      handler: async (req, res) => {
        if (req.method === 'GET') {
          sendJson(res, 200, config)
          return
        }
        if (req.method === 'PUT') {
          try {
            const parsed: unknown = JSON.parse(await readBody(req, MAX_CONFIG_BODY_BYTES))
            // 与启动时同一条合并链：loader 旧配置 → 预设 → 显式字段。
            const next = resolveSettings(raw, parsed)
            saveUserConfig(next)
            config = next
            sendJson(res, 200, config)
          } catch (error) {
            sendJson(res, 400, {
              error: 'INVALID_CONFIG',
              message: error instanceof Error ? error.message : '配置不是合法 JSON',
            })
          }
          return
        }
        res.setHeader('allow', 'GET, PUT')
        res.writeHead(405)
        res.end('method not allowed')
      },
    }), `${name}: config api`)
  })

  const lastSeenStatus = new Map<string, 'idle' | 'running'>()
  const lastNotified = new Map<string, number>()
  const activeNotifiers = new Set<ChildProcess>()
  const decisionPanels = new Map<string, ChildProcess>()

  const log = (message: string): void => {
    const line = `[${new Date().toISOString()}] ${message}`
    try {
      mkdirSync(dirname(logFile), { recursive: true })
      appendFileSync(logFile, line + '\n')
    } catch {
      /* 日志失败不影响通知 */
    }
    ctx.logger?.info?.(`[${name}] ${message}`)
  }

  /** 同一事件在 quietSeconds 内只提醒一次（防止 turn 边界/重连造成刷屏）。 */
  const dedupe = (key: string): boolean => {
    const now = Date.now()
    const last = lastNotified.get(key) ?? 0
    if (now - last < config.quietSeconds * 1000) return false
    lastNotified.set(key, now)
    if (lastNotified.size > 200) {
      const oldest = [...lastNotified.entries()].sort((a, b) => a[1] - b[1])[0]
      if (oldest) lastNotified.delete(oldest[0])
    }
    return true
  }

  const trackSpawn = (child: ChildProcess): void => {
    activeNotifiers.add(child)
    child.once('exit', () => activeNotifiers.delete(child))
    child.unref?.()
  }

  /* ─────────── 通知中心横幅（best-effort） ─────────── */
  const desktopNotify = (title: string, message: string, sound = 'Glass'): void => {
    if (!config.desktop) return
    const safeTitle = appleScriptString(title)
    const safeMessage = appleScriptString(message)
    const safeSound = appleScriptString(sound)
    if (process.platform === 'darwin') {
      const script = `display notification ${safeMessage} with title ${safeTitle} sound name ${safeSound}`
      execFile('/usr/bin/osascript', ['-e', script], { timeout: 5000 }, () => {
        /* 通知失败不抛错 */
      })
    } else if (process.platform === 'linux') {
      execFile('notify-send', [title, message], { timeout: 5000 }, () => {
        /* 没有 notify-send 就算了 */
      })
    } else if (process.platform === 'win32') {
      const ps = `[void][Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms');` +
        `$n=[System.Windows.Forms.NotifyIcon]::new();` +
        `$n.Icon=[System.Drawing.SystemIcons]::Information;` +
        `$n.BalloonTipTitle=${JSON.stringify(title)};` +
        `$n.BalloonTipText=${JSON.stringify(message)};` +
        `$n.Visible=$true;$n.ShowBalloonTip(8000);Start-Sleep -Seconds 8;$n.Dispose()`
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 12000 }, () => {
        /* 尽力而为 */
      })
    }
  }

  /* ─────────── 跨窗口悬浮面板 ─────────── */

  let darwinBinary: string | null = null
  let darwinCompile: Promise<string | null> | null = null

  /** 首次使用时用 swiftc 编译内置 notifier，缓存到 ~/.dsh/plugins/dsh-notifier/DSHNotifier。 */
  function ensureDarwinNotifier(): Promise<string | null> {
    if (darwinBinary) return Promise.resolve(darwinBinary)
    if (darwinCompile) return darwinCompile
    darwinCompile = (async () => {
      try {
        const bin = join(notifierDir, 'DSHNotifier')
        if (existsSync(bin)) {
          darwinBinary = bin
          return bin
        }
        const src = fileURLToPath(new URL('../assets/macos/DSHNotifier.swift', import.meta.url))
        if (!existsSync(src)) return null
        mkdirSync(notifierDir, { recursive: true })
        const result = spawnSync('swiftc', ['-O', '-swift-version', '5', src, '-o', bin], {
          timeout: 90_000,
          encoding: 'utf8',
        })
        if (result.status !== 0 || !existsSync(bin)) {
          log(`swift notifier 编译失败，回退到 osascript：${(result.stderr || result.error?.message || '').slice(0, 200)}`)
          return null
        }
        darwinBinary = bin
        log(`swift notifier 已就绪：${bin}`)
        return bin
      } catch (error) {
        log(`swift notifier 准备失败：${errorText(error)}`)
        return null
      }
    })()
    return darwinCompile
  }

  const registerPanel = (child: ChildProcess, key?: string): ChildProcess => {
    trackSpawn(child)
    if (key) {
      decisionPanels.get(key)?.kill()
      decisionPanels.set(key, child)
      child.once('exit', () => {
        if (decisionPanels.get(key) === child) decisionPanels.delete(key)
      })
    }
    return child
  }

  async function floatingNotify(
    kind: NotifyKind,
    title: string,
    message: string,
    opts: FloatingOptions,
  ): Promise<ChildProcess | null> {
    if (!config.floating) return null
    const ttl = opts.sticky ? 0 : 10
    const secondary = opts.sticky ? '忽略' : '知道了'
    const args = [
      '--kind', kind,
      '--title', title,
      '--message', message,
      '--primary', opts.primaryLabel,
      '--secondary', secondary,
      '--url', config.webUrl,
      '--ttl', String(ttl),
    ]
    try {
      if (process.platform === 'darwin') {
        const bin = await ensureDarwinNotifier()
        if (bin) {
          const child = spawn(bin, args, { detached: true, stdio: 'ignore' })
          return registerPanel(child, opts.panelKey)
        }
        // 回退：有按钮的用 display dialog；无按钮的退回通知中心横幅。
        if (opts.sticky) {
          const script =
            `set answer to button returned of (display dialog ${appleScriptString(message)} ` +
            `with title ${appleScriptString(title)} ` +
            `buttons {${appleScriptString('忽略')}, ${appleScriptString(opts.primaryLabel)}} ` +
            `default button ${appleScriptString(opts.primaryLabel)} with icon caution)\n` +
            `if answer is ${appleScriptString(opts.primaryLabel)} then do shell script "open ${config.webUrl.replace(/"/g, '\\"')}"`
          execFile('/usr/bin/osascript', ['-e', script], { timeout: 120_000 }, () => {})
        }
        return null
      }
      if (process.platform === 'linux') {
        // zenity 提供跨窗口对话框；没有 zenity 时退化为 notify-send。
        const hasZenity = spawnSync('which', ['zenity'], { encoding: 'utf8' }).status === 0
        if (hasZenity) {
          const script =
            `zenity --question --title ${shellQuote(title)} --text ${shellQuote(message)} ` +
            `--ok-label ${shellQuote(opts.primaryLabel)} --cancel-label ${shellQuote(secondary)} ` +
            `&& xdg-open ${shellQuote(config.webUrl)}`
          const child = spawn('/bin/sh', ['-c', script], { detached: true, stdio: 'ignore' })
          return registerPanel(child, opts.panelKey)
        }
        return null
      }
      if (process.platform === 'win32') {
        // Windows 自带 WScript.Shell.Popup：跨窗口系统弹窗，支持超时自动消失。
        // YesNo 按钮返回 6（Yes）/ 7（No）；spawn 子进程以便决策解决时联动关闭。
        const buttonKind = opts.sticky ? '4' : '0'
        const timeoutSeconds = opts.sticky ? '0' : String(ttl)
        const ps =
          `$ws = New-Object -ComObject WScript.Shell;` +
          `$r = $ws.Popup(${psString(message)}, ${timeoutSeconds}, ${psString(title)}, ` +
          `${buttonKind} + 64);` +
          (opts.sticky ? `if ($r -eq 6) { Start-Process ${psString(config.webUrl)} }` : '')
        const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'ignore' })
        return registerPanel(child, opts.panelKey)
      }
    } catch (error) {
      log(`floating notify 失败：${errorText(error)}`)
    }
    return null
  }

  const notify = (
    kind: NotifyKind,
    title: string,
    message: string,
    opts: FloatingOptions,
  ): void => {
    const key = `${kind}:${message}`
    if (!dedupe(key)) return
    log(`${kind} → ${title} | ${message}`)
    desktopNotify(title, message, KIND_SOUND[kind])
    void floatingNotify(kind, title, message, opts)
  }

  /* ─────────── 事件监听（Hook） ─────────── */

  ctx.on('agent/status', ({ agent, status }) => {
    const previous = lastSeenStatus.get(agent.id)
    lastSeenStatus.set(agent.id, status)
    if (previous === 'running' && status === 'idle') {
      notify('done', 'DSH 任务完成', `会话 ${shortId(agent.id)} 已运行结束，可以查看结果了`, {
        sticky: false,
        primaryLabel: '查看会话',
      })
    }
  })

  ctx.on('approval/request', (req, next) => {
    const tool = req.toolName ?? '一个工具'
    const reason = req.reason ? `：${req.reason}` : ''
    notify('approval', 'DSH 需要你的批准', `会话 ${shortId(req.agent.id)} 请求执行「${tool}」${reason}`, {
      sticky: true,
      primaryLabel: '去处理',
    })
    return next()
  })

  // 权威观察面：approval/request 是 waterfall，web 审批 answerer 可能先截断链路，
  // 因此同时监听持久化审计事件 session/event。dedupe 会把两条路径合并为一条。
  ctx.on('session/event', (session, event) => {
    if (event.type === 'approval/asked') {
      const tool = event.data?.toolName ?? '一个工具'
      const reason = event.data?.reason ? `：${event.data.reason}` : ''
      const panelKey = event.data?.id ? `approval:${event.data.id}` : undefined
      notify('approval', 'DSH 需要你的批准', `会话 ${shortId(session.id)} 请求执行「${tool}」${reason}`, {
        sticky: true,
        primaryLabel: '去处理',
        panelKey,
      })
    } else if (event.type === 'approval/decided') {
      if (event.data?.id) {
        const key = `approval:${event.data.id}`
        decisionPanels.get(key)?.kill()
        decisionPanels.delete(key)
      }
    } else if (event.type === 'tool/call' && event.data?.name === 'ask_user_question') {
      const panelKey = event.data.callId ? `question:${event.data.callId}` : undefined
      notify('question', 'DSH 需要你回答', `会话 ${shortId(session.id)} 正在等待你回答问题`, {
        sticky: true,
        primaryLabel: '去处理',
        panelKey,
      })
    } else if (event.type === 'tool/result') {
      const callId = event.data?.message?.source?.callId
      if (callId) {
        const key = `question:${callId}`
        decisionPanels.get(key)?.kill()
        decisionPanels.delete(key)
      }
    }
  })

  ctx.on('agent/error', ({ agent, error }) => {
    notify('error', 'DSH 任务出错', `会话 ${shortId(agent.id)}：${errorText(error)}`, {
      sticky: false,
      primaryLabel: '查看会话',
    })
  })

  ctx.effect(() => () => {
    for (const child of activeNotifiers) {
      try { child.kill() } catch { /* 已退出 */ }
    }
  }, `${name}: notifier cleanup`)

  log(`host half 已启动（desktop=${config.desktop}, floating=${config.floating}, webUrl=${config.webUrl}）`)
}
