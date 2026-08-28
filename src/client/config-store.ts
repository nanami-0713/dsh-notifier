/**
 * @hsinsekai-nanami/dsh-notifier — client 配置 store。
 * 读取 / 保存 host 同源 API，preview 立即把草稿推给 toast 渲染层。
 */
import {
  CONFIG_API_PATH,
  DEFAULT_SETTINGS,
  normalizeSettings,
  type NotifierSettings,
} from '../shared'

export type StoreStatus = 'loading' | 'ready' | 'saving' | 'error'

export interface StoreState {
  status: StoreStatus
  settings: NotifierSettings
  error?: string
}

export class NotifierStore {
  private state: StoreState = { status: 'loading', settings: DEFAULT_SETTINGS }
  private listeners = new Set<() => void>()
  private tail: Promise<void> = Promise.resolve()

  getSnapshot = (): StoreState => this.state

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private setState(patch: Partial<StoreState>): void {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener()
  }

  /** 立即把草稿推给全局 toast 层，不等待网络。 */
  preview(settings: NotifierSettings): void {
    this.setState({ settings })
  }

  async load(): Promise<void> {
    try {
      const response = await fetch(CONFIG_API_PATH, { cache: 'no-store' })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const settings = normalizeSettings(await response.json())
      this.setState({ status: 'ready', settings })
    } catch {
      this.setState({ status: 'ready', settings: normalizeSettings(DEFAULT_SETTINGS) })
    }
  }

  save(settings: NotifierSettings): Promise<void> {
    this.setState({ status: 'saving', settings })
    const task = this.tail
      .catch(() => undefined)
      .then(async () => {
        try {
          const response = await fetch(CONFIG_API_PATH, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(settings),
          })
          if (!response.ok) {
            const payload = (await response.json().catch(() => null)) as { message?: string } | null
            throw new Error(payload?.message ?? `HTTP ${response.status}`)
          }
          const saved = normalizeSettings(await response.json())
          this.setState({ status: 'ready', settings: saved })
        } catch (error) {
          this.setState({
            status: 'error',
            error: error instanceof Error ? error.message : String(error),
          })
        }
      })
    this.tail = task
    return task
  }
}
