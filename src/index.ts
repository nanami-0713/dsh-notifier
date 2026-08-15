/**
 * @dsh-external/dsh-notifier — host half（桌面通知）。
 *
 * 监听 DSH 运行时事件，在「任务结束」和「需要用户决策」时发一条操作系统级
 * 原生通知（macOS / Linux / Windows 尽力而为），并把事件写入插件日志：
 * - agent/status: running → idle 边沿 = 一次任务结束
 * - approval/request: 权限审批询问（观察者：只提醒，不劫持 answerer 链）
 * - agent/error: 无 turn 位置的 agent 失败
 *
 * web 内的 toast 弹窗由 client half（src/client）负责，两者相互独立，
 * 任一失效都不影响另一半。
 */
import { execFile } from 'node:child_process'
import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'

export const name = '@dsh-external/dsh-notifier'
export const inject = []

export interface NotifierConfig {
  /** 发操作系统原生通知（默认 true） */
  desktop?: boolean
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

const DEFAULTS: Required<NotifierConfig> = {
  desktop: true,
  quietSeconds: 8,
}

function shortId(id: string): string {
  return id.length > 12 ? id.slice(0, 12) : id
}

function appleScriptString(text: string): string {
  // AppleScript 字符串字面量用双引号，把换行压平避免多行脚本问题。
  return JSON.stringify(String(text).replace(/[\r\n]+/g, ' '))
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error).slice(0, 200)
}

export function apply(ctx: Context, raw: NotifierConfig = {}): void {
  const config: Required<NotifierConfig> = { ...DEFAULTS, ...raw }
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  const logFile = join(dshHome, 'super-injector', 'dsh-notifier.log')
  const lastSeenStatus = new Map<string, 'idle' | 'running'>()
  const lastNotified = new Map<string, number>()

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

  const notify = (kind: string, title: string, message: string, sound?: string): void => {
    const key = `${kind}:${message}`
    if (!dedupe(key)) return
    log(`${kind} → ${title} | ${message}`)
    desktopNotify(title, message, sound)
  }

  ctx.on('agent/status', ({ agent, status }) => {
    const previous = lastSeenStatus.get(agent.id)
    lastSeenStatus.set(agent.id, status)
    if (previous === 'running' && status === 'idle') {
      notify('task-done', 'DSH 任务完成', `会话 ${shortId(agent.id)} 已运行结束，可以查看结果了`, 'Glass')
    }
  })

  ctx.on('approval/request', (req, next) => {
    const tool = req.toolName ?? '一个工具'
    const reason = req.reason ? `：${req.reason}` : ''
    notify(
      'approval-needed',
      'DSH 需要你的决策',
      `会话 ${shortId(req.agent.id)} 请求执行「${tool}」${reason}`,
      'Ping',
    )
    return next()
  })

  // 权威观察面：approval/request 是 waterfall，web 审批 answerer 可能先截断链路，
  // 因此同时监听持久化审计事件 session/event（approval/asked / ask_user_question 工具调用）。
  // dedupe 会把两条路径产生的重复通知合并为一条。
  ctx.on('session/event', (session, event) => {
    if (event.type === 'approval/asked') {
      const tool = event.data?.toolName ?? '一个工具'
      const reason = event.data?.reason ? `：${event.data.reason}` : ''
      notify(
        'approval-needed',
        'DSH 需要你的决策',
        `会话 ${shortId(session.id)} 请求执行「${tool}」${reason}`,
        'Ping',
      )
    } else if (event.type === 'tool/call' && event.data?.name === 'ask_user_question') {
      notify(
        'question-needed',
        'DSH 需要你回答',
        `会话 ${shortId(session.id)} 正在等待你回答问题`,
        'Ping',
      )
    }
  })

  ctx.on('agent/error', ({ agent, error }) => {
    notify('agent-error', 'DSH 任务出错', `会话 ${shortId(agent.id)}：${errorText(error)}`, 'Basso')
  })

  log(`host half 已启动（desktop=${config.desktop}, quietSeconds=${config.quietSeconds}）`)
}
