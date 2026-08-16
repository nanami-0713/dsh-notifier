/**
 * @dsh-external/dsh-notifier — 共享配置模型（host 与 client 共用）。
 *
 * 用户配置持久化在 ~/.dsh/plugins/dsh-notifier/config.json，
 * 由 host 半通过同源 HTTP API 读写；默认走 `default` 预设，
 * 用户修改任意字段后自动标记为 `custom` 预设。
 */

export const PLUGIN_ID = '@dsh-external/dsh-notifier'

export const CONFIG_API_PATH = '/api/dsh-notifier/config'

export type ToastPosition = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left'
export type ToastTheme = 'dark' | 'light'

export interface ToastStyle {
  /** 是否显示 DSH 网页内的 toast。 */
  enabled: boolean
  position: ToastPosition
  theme: ToastTheme
  /** 弹窗宽度 px（320–560）。 */
  width: number
  /** 卡片圆角 px（6–20）。 */
  radius: number
  /** 弹窗提示音。 */
  sound: boolean
  /** 普通提示自动关闭秒数（4–30）。 */
  durationSeconds: number
  /** 错误提示自动关闭秒数（4–30）。 */
  errorDurationSeconds: number
  /** 同屏最多卡片数（1–10）。 */
  maxCount: number
}

export interface NotifierSettings {
  version: number
  /** 当前预设 id；手动修改任意字段后为 custom。 */
  preset: string
  toast: ToastStyle
  /** 跨窗口系统弹窗（macOS Swift notifier / Windows WScript.Popup / Linux zenity）。 */
  floating: boolean
  /** 系统通知中心横幅。 */
  desktop: boolean
  /** 同一事件最短重复提醒间隔（秒）。 */
  quietSeconds: number
  /** 系统弹窗「去处理」按钮打开的 DSH 地址。 */
  webUrl: string
}

export interface NotifierPreset {
  id: string
  name: string
  description: string
  settings: Omit<NotifierSettings, 'version' | 'preset'>
}

export const DEFAULT_SETTINGS: NotifierSettings = Object.freeze({
  version: 1,
  preset: 'default',
  toast: Object.freeze({
    enabled: true,
    position: 'bottom-right' as const,
    theme: 'dark' as const,
    width: 380,
    radius: 14,
    sound: true,
    durationSeconds: 6,
    errorDurationSeconds: 10,
    maxCount: 6,
  }),
  floating: true,
  desktop: true,
  quietSeconds: 8,
  webUrl: 'http://127.0.0.1:3080',
})

export const NOTIFIER_PRESETS: readonly NotifierPreset[] = [
  {
    id: 'default',
    name: '默认',
    description: '网页右下角深色 toast + 跨窗口系统弹窗 + 通知中心，开箱即用',
    settings: {
      toast: { ...DEFAULT_SETTINGS.toast },
      floating: true,
      desktop: true,
      quietSeconds: 8,
      webUrl: DEFAULT_SETTINGS.webUrl,
    },
  },
  {
    id: 'top-light',
    name: '顶部浅色',
    description: '浅色卡片显示在右上角，系统弹窗保持开启',
    settings: {
      toast: {
        enabled: true,
        position: 'top-right',
        theme: 'light',
        width: 420,
        radius: 16,
        sound: true,
        durationSeconds: 6,
        errorDurationSeconds: 10,
        maxCount: 6,
      },
      floating: true,
      desktop: true,
      quietSeconds: 8,
      webUrl: DEFAULT_SETTINGS.webUrl,
    },
  },
  {
    id: 'focus',
    name: '专注',
    description: '只保留网页 toast，关闭跨窗口弹窗与系统通知，降低打扰',
    settings: {
      toast: {
        enabled: true,
        position: 'bottom-right',
        theme: 'dark',
        width: 360,
        radius: 12,
        sound: false,
        durationSeconds: 10,
        errorDurationSeconds: 15,
        maxCount: 4,
      },
      floating: false,
      desktop: false,
      quietSeconds: 30,
      webUrl: DEFAULT_SETTINGS.webUrl,
    },
  },
  {
    id: 'native-only',
    name: '仅系统弹窗',
    description: '关闭网页 toast，只保留跨窗口弹窗与系统通知',
    settings: {
      toast: { ...DEFAULT_SETTINGS.toast, enabled: false },
      floating: true,
      desktop: true,
      quietSeconds: 8,
      webUrl: DEFAULT_SETTINGS.webUrl,
    },
  },
]

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

function boolValue(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function stringValue(value: unknown, fallback: string, maxLength = 256): string {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  if (!trimmed) return fallback
  return trimmed.slice(0, maxLength)
}

function oneOf<T extends string>(value: unknown, options: readonly T[], fallback: T): T {
  if (typeof value === 'string' && (options as readonly string[]).includes(value)) return value as T
  return fallback
}

export function normalizeSettings(input: unknown): NotifierSettings {
  const root = isRecord(input) ? input : {}
  const toast = isRecord(root.toast) ? root.toast : {}
  const settings: NotifierSettings = {
    version: 1,
    preset: stringValue(root.preset, DEFAULT_SETTINGS.preset, 64),
    toast: {
      enabled: boolValue(toast.enabled, DEFAULT_SETTINGS.toast.enabled),
      position: oneOf<ToastPosition>(
        toast.position,
        ['bottom-right', 'bottom-left', 'top-right', 'top-left'],
        DEFAULT_SETTINGS.toast.position,
      ),
      theme: oneOf<ToastTheme>(toast.theme, ['dark', 'light'], DEFAULT_SETTINGS.toast.theme),
      width: Math.round(clampNumber(toast.width, 320, 560, DEFAULT_SETTINGS.toast.width)),
      radius: Math.round(clampNumber(toast.radius, 6, 20, DEFAULT_SETTINGS.toast.radius)),
      sound: boolValue(toast.sound, DEFAULT_SETTINGS.toast.sound),
      durationSeconds: Math.round(clampNumber(toast.durationSeconds, 4, 30, DEFAULT_SETTINGS.toast.durationSeconds)),
      errorDurationSeconds: Math.round(clampNumber(toast.errorDurationSeconds, 4, 30, DEFAULT_SETTINGS.toast.errorDurationSeconds)),
      maxCount: Math.round(clampNumber(toast.maxCount, 1, 10, DEFAULT_SETTINGS.toast.maxCount)),
    },
    floating: boolValue(root.floating, DEFAULT_SETTINGS.floating),
    desktop: boolValue(root.desktop, DEFAULT_SETTINGS.desktop),
    quietSeconds: Math.round(clampNumber(root.quietSeconds, 0, 120, DEFAULT_SETTINGS.quietSeconds)),
    webUrl: stringValue(root.webUrl, DEFAULT_SETTINGS.webUrl, 512),
  }
  settings.preset = canonicalPresetId(settings)
  return settings
}

/** 忽略 preset/version/webUrl 的行为指纹，用于判断当前配置匹配哪个内置预设。 */
export function settingsFingerprint(settings: NotifierSettings): string {
  return JSON.stringify({
    toast: settings.toast,
    floating: settings.floating,
    desktop: settings.desktop,
    quietSeconds: settings.quietSeconds,
  })
}

export function presetById(id: string): NotifierPreset | undefined {
  return NOTIFIER_PRESETS.find((preset) => preset.id === id)
}

/** 若当前配置与某个内置预设完全一致则返回该预设 id，否则返回 custom。 */
export function canonicalPresetId(settings: NotifierSettings): string {
  const fingerprint = settingsFingerprint(settings)
  const matched = NOTIFIER_PRESETS.find((preset) => {
    const candidate: NotifierSettings = {
      ...DEFAULT_SETTINGS,
      ...preset.settings,
      preset: preset.id,
    }
    return fingerprint === settingsFingerprint(candidate)
  })
  return matched?.id ?? 'custom'
}

/** 应用一个预设：完整替换行为字段，并带上预设 id。 */
export function applyPreset(current: NotifierSettings, preset: NotifierPreset): NotifierSettings {
  return normalizeSettings({
    ...preset.settings,
    preset: preset.id,
    webUrl: current.webUrl,
  })
}
