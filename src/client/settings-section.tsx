/**
 * @dsh-external/dsh-notifier — 设置页（settings.section）。
 * 预设一键切换 + 网页 toast 样式/位置 + 跨窗口与系统通知开关。
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { CSSProperties } from 'react'
import {
  DEFAULT_SETTINGS,
  NOTIFIER_PRESETS,
  applyPreset,
  normalizeSettings,
  type NotifierPreset,
  type NotifierSettings,
  type ToastPosition,
  type ToastTheme,
} from '../shared'
import type { NotifierStore } from './config-store'

export const NOTIFIER_SETTINGS_CSS = `
.dns-root{display:flex;flex-direction:column;gap:12px;max-width:680px;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary)}
.dns-card{display:flex;flex-direction:column;gap:12px;padding:14px;border-radius:14px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1)}
.dns-card h3{margin:0;font-size:13px;font-weight:600}
.dns-muted{color:var(--dsw-alias-label-secondary);font-size:12px;margin:0}
.dns-error{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:8px 12px;border-radius:10px;border:1px solid var(--dsw-alias-state-error-secondary);background:var(--dsw-alias-state-error-tertiary);color:var(--dsw-alias-state-error-primary);font-size:12px}
.dns-btn{font:inherit;font-size:12px;line-height:18px;padding:5px 12px;border-radius:9px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-button-elevated-fill);color:var(--dsw-alias-label-primary);cursor:pointer}
.dns-btn:hover{background:var(--dsw-alias-button-floating-hover)}
.dns-btn.danger{color:var(--dsw-alias-state-error-primary)}
.dns-presets{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
.dns-preset{display:flex;flex-direction:column;gap:6px;padding:12px;border-radius:12px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);cursor:pointer;text-align:left;font:inherit;color:inherit}
.dns-preset:hover{border-color:var(--dsw-alias-border-l3);background:var(--dsw-alias-interactive-bg-hover)}
.dns-preset.active{border-color:var(--dsw-alias-brand-primary-new-colorprimary-new-color);box-shadow:0 0 0 1px var(--dsw-alias-brand-primary-new-colorprimary-new-color) inset}
.dns-preset-name{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}
.dns-preset-desc{font-size:11px;line-height:1.45;color:var(--dsw-alias-label-tertiary)}
.dns-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
.dns-field{display:flex;flex-direction:column;gap:6px;min-width:0}
.dns-label{font-size:12px;color:var(--dsw-alias-label-secondary)}
.dns-input{font:inherit;font-size:12px;line-height:20px;padding:7px 10px;border-radius:9px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);width:100%;box-sizing:border-box}
.dns-row{display:flex;align-items:center;justify-content:space-between;gap:10px}
.dns-value{min-width:48px;text-align:right;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary)}
.dns-check{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer;user-select:none}
.dns-check input{accent-color:var(--dsw-alias-brand-primary-new-colorprimary-new-color)}
.dns-range{width:100%;accent-color:var(--dsw-alias-brand-primary-new-colorprimary-new-color)}
.dns-seg{display:flex;gap:0;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;overflow:hidden;width:fit-content;flex-wrap:wrap}
.dns-seg button{font:inherit;font-size:12px;padding:6px 12px;border:none;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);cursor:pointer}
.dns-seg button.active{background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary)}
.dns-preview{position:relative;height:120px;border-radius:12px;border:1px solid var(--dsw-alias-border-l2);overflow:hidden;background:var(--dsw-alias-bg-base)}
.dns-preview-toast{position:absolute;display:flex;gap:8px;align-items:flex-start;padding:10px 12px;box-shadow:0 10px 28px rgba(2,6,23,.35)}
@media (max-width:640px){.dns-grid,.dns-presets{grid-template-columns:1fr}}
`

function RangeField(props: {
  label: string
  value: number
  min: number
  max: number
  suffix?: string
  onChange: (value: number) => void
}): JSX.Element {
  return (
    <div className="dns-field">
      <div className="dns-row">
        <span className="dns-label">{props.label}</span>
        <span className="dns-value">
          {props.value}
          {props.suffix ?? ''}
        </span>
      </div>
      <input
        type="range"
        className="dns-range"
        min={props.min}
        max={props.max}
        step={1}
        value={props.value}
        onChange={(event) => props.onChange(Number(event.target.value))}
      />
    </div>
  )
}

function Segmented<T extends string>(props: {
  options: ReadonlyArray<{ label: string; value: T }>
  value: T
  onChange: (value: T) => void
}): JSX.Element {
  return (
    <div className="dns-seg" role="tablist">
      {props.options.map((option) => (
        <button
          type="button"
          key={option.value}
          role="tab"
          aria-selected={option.value === props.value}
          className={option.value === props.value ? 'active' : undefined}
          onClick={() => props.onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

const POSITION_OPTIONS: ReadonlyArray<{ label: string; value: ToastPosition }> = [
  { label: '右下', value: 'bottom-right' },
  { label: '左下', value: 'bottom-left' },
  { label: '右上', value: 'top-right' },
  { label: '左上', value: 'top-left' },
]

const THEME_OPTIONS: ReadonlyArray<{ label: string; value: ToastTheme }> = [
  { label: '深色', value: 'dark' },
  { label: '浅色', value: 'light' },
]

function previewStyle(settings: NotifierSettings): CSSProperties {
  const dark = settings.toast.theme === 'dark'
  return {
    width: Math.min(settings.toast.width, 300),
    borderRadius: settings.toast.radius,
    background: dark ? 'rgba(17,24,39,.96)' : 'rgba(255,255,255,.98)',
    border: dark ? '1px solid rgba(148,163,184,.28)' : '1px solid rgba(15,23,42,.12)',
    color: dark ? '#E5E7EB' : '#111827',
    ...(settings.toast.position.includes('bottom')
      ? { bottom: 12 }
      : { top: 12 }),
    ...(settings.toast.position.includes('right')
      ? { right: 12 }
      : { left: 12 }),
  }
}

function presetMatches(settings: NotifierSettings, preset: NotifierPreset): boolean {
  const candidate = applyPreset(settings, preset)
  return JSON.stringify({
    toast: settings.toast,
    floating: settings.floating,
    desktop: settings.desktop,
    quietSeconds: settings.quietSeconds,
  }) === JSON.stringify({
    toast: candidate.toast,
    floating: candidate.floating,
    desktop: candidate.desktop,
    quietSeconds: candidate.quietSeconds,
  })
}

export function NotifierSettingsSection(props: { store: NotifierStore }): JSX.Element {
  const { store } = props
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const [draft, setDraft] = useState<NotifierSettings>(() => state.settings)
  const draftRef = useRef(draft)
  const dirtyRef = useRef(false)
  const initializedRef = useRef(false)

  useEffect(() => {
    if (!initializedRef.current && state.status !== 'loading') {
      initializedRef.current = true
      draftRef.current = state.settings
      setDraft(state.settings)
    }
  }, [state.status, state.settings])

  useEffect(() => {
    if (!initializedRef.current || !dirtyRef.current) return
    const timer = window.setTimeout(() => {
      void store.save(draftRef.current)
    }, 300)
    return () => window.clearTimeout(timer)
  }, [draft, store])

  useEffect(
    () => () => {
      if (dirtyRef.current) void store.save(draftRef.current)
    },
    [store],
  )

  const commit = (next: NotifierSettings): void => {
    const normalized = normalizeSettings(next)
    draftRef.current = normalized
    dirtyRef.current = true
    store.preview(normalized)
    setDraft(normalized)
  }

  const mutate = (mutator: (previous: NotifierSettings) => NotifierSettings): void => {
    commit(mutator(draftRef.current))
  }

  const resetAll = (): void => {
    if (window.confirm('确定恢复「提醒通知」的全部默认设置吗？')) {
      commit(normalizeSettings(DEFAULT_SETTINGS))
    }
  }

  const retrySave = (): void => {
    void store.save(draftRef.current)
  }

  return (
    <div className="dns-root">
      <p className="dns-muted">
        配置保存在 ~/.dsh/plugins/dsh-notifier/config.json；修改后实时生效并自动保存。
      </p>

      {state.status === 'error' && (
        <div className="dns-error">
          <span>保存失败：{state.error ?? '未知错误'}</span>
          <button type="button" className="dns-btn" onClick={retrySave}>
            重试
          </button>
        </div>
      )}

      <div className="dns-card">
        <h3>配置预设</h3>
        <div className="dns-presets">
          {NOTIFIER_PRESETS.map((preset) => (
            <button
              type="button"
              key={preset.id}
              className={presetMatches(draft, preset) ? 'dns-preset active' : 'dns-preset'}
              onClick={() => commit(applyPreset(draft, preset))}
            >
              <span className="dns-preset-name">{preset.name}</span>
              <span className="dns-preset-desc">{preset.description}</span>
            </button>
          ))}
        </div>
        <p className="dns-muted">
          当前预设：
          {NOTIFIER_PRESETS.find((preset) => presetMatches(draft, preset))?.name ?? '自定义'}
          ；手动修改任意字段会自动变成「自定义」。
        </p>
      </div>

      <div className="dns-card">
        <h3>网页内 toast 弹窗</h3>
        <label className="dns-check">
          <input
            type="checkbox"
            checked={draft.toast.enabled}
            onChange={(event) =>
              mutate((previous) => ({
                ...previous,
                preset: 'custom',
                toast: { ...previous.toast, enabled: event.target.checked },
              }))
            }
          />
          在 DSH 网页内显示 toast
        </label>
        <div className="dns-grid">
          <div className="dns-field">
            <span className="dns-label">位置</span>
            <Segmented
              options={POSITION_OPTIONS}
              value={draft.toast.position}
              onChange={(position) =>
                mutate((previous) => ({
                  ...previous,
                  preset: 'custom',
                  toast: { ...previous.toast, position },
                }))
              }
            />
          </div>
          <div className="dns-field">
            <span className="dns-label">主题</span>
            <Segmented
              options={THEME_OPTIONS}
              value={draft.toast.theme}
              onChange={(theme) =>
                mutate((previous) => ({
                  ...previous,
                  preset: 'custom',
                  toast: { ...previous.toast, theme },
                }))
              }
            />
          </div>
        </div>
        <RangeField
          label="宽度"
          value={draft.toast.width}
          min={320}
          max={560}
          suffix="px"
          onChange={(width) =>
            mutate((previous) => ({
              ...previous,
              preset: 'custom',
              toast: { ...previous.toast, width },
            }))
          }
        />
        <RangeField
          label="圆角"
          value={draft.toast.radius}
          min={6}
          max={20}
          suffix="px"
          onChange={(radius) =>
            mutate((previous) => ({
              ...previous,
              preset: 'custom',
              toast: { ...previous.toast, radius },
            }))
          }
        />
        <RangeField
          label="普通提示停留"
          value={draft.toast.durationSeconds}
          min={4}
          max={30}
          suffix="s"
          onChange={(durationSeconds) =>
            mutate((previous) => ({
              ...previous,
              preset: 'custom',
              toast: { ...previous.toast, durationSeconds },
            }))
          }
        />
        <RangeField
          label="错误提示停留"
          value={draft.toast.errorDurationSeconds}
          min={4}
          max={30}
          suffix="s"
          onChange={(errorDurationSeconds) =>
            mutate((previous) => ({
              ...previous,
              preset: 'custom',
              toast: { ...previous.toast, errorDurationSeconds },
            }))
          }
        />
        <RangeField
          label="同屏最多卡片"
          value={draft.toast.maxCount}
          min={1}
          max={10}
          suffix="张"
          onChange={(maxCount) =>
            mutate((previous) => ({
              ...previous,
              preset: 'custom',
              toast: { ...previous.toast, maxCount },
            }))
          }
        />
        <label className="dns-check">
          <input
            type="checkbox"
            checked={draft.toast.sound}
            onChange={(event) =>
              mutate((previous) => ({
                ...previous,
                preset: 'custom',
                toast: { ...previous.toast, sound: event.target.checked },
              }))
            }
          />
          提示音
        </label>
      </div>

      <div className="dns-card">
        <h3>系统级提醒</h3>
        <label className="dns-check">
          <input
            type="checkbox"
            checked={draft.floating}
            onChange={(event) =>
              mutate((previous) => ({ ...previous, preset: 'custom', floating: event.target.checked }))
            }
          />
          跨窗口弹窗（审批 / 提问会钉住；macOS Swift / Windows WScript / Linux zenity）
        </label>
        <label className="dns-check">
          <input
            type="checkbox"
            checked={draft.desktop}
            onChange={(event) =>
              mutate((previous) => ({ ...previous, preset: 'custom', desktop: event.target.checked }))
            }
          />
          系统通知中心横幅
        </label>
        <RangeField
          label="相同事件静默间隔"
          value={draft.quietSeconds}
          min={0}
          max={120}
          suffix="s"
          onChange={(quietSeconds) =>
            mutate((previous) => ({ ...previous, preset: 'custom', quietSeconds }))
          }
        />
      </div>

      <div className="dns-card">
        <h3>手机推送（DSH-Remote 桥接）</h3>
        <p className="dns-muted">
          在 dsh-remote bridge 配置了地址和主 token 后，PC 弹窗的「任务完成」「需要你回答」
          会同步推给已连接的手机 App（App 前台时显示横幅，可点击直达会话）。留空 = 关闭。
        </p>
        <div className="dns-field">
          <span className="dns-label">bridge 地址（如 http://127.0.0.1:8787）</span>
          <input
            type="text"
            className="dns-input"
            placeholder="http://127.0.0.1:8787"
            value={draft.bridgeUrl}
            onChange={(event) =>
              mutate((previous) => ({
                ...previous,
                preset: 'custom',
                bridgeUrl: event.target.value,
              }))
            }
          />
        </div>
        <div className="dns-field">
          <span className="dns-label">bridge 主 token（与 bridge config.json 的 token 一致）</span>
          <input
            type="password"
            className="dns-input"
            placeholder="留空则不转发"
            value={draft.bridgeToken}
            onChange={(event) =>
              mutate((previous) => ({
                ...previous,
                preset: 'custom',
                bridgeToken: event.target.value,
              }))
            }
          />
        </div>
      </div>

      <div className="dns-card">
        <h3>预览</h3>
        <div className="dns-preview">
          <div className="dns-preview-toast" style={previewStyle(draft)}>
            <span>✅</span>
            <div>
              <div style={{ fontSize: 12, fontWeight: 650 }}>DSH 任务完成</div>
              <div style={{ fontSize: 11, opacity: 0.72 }}>会话已运行结束，可以查看结果了</div>
            </div>
          </div>
        </div>
      </div>

      <div className="dns-row">
        <span className="dns-muted">所有修改实时预览，并自动保存到本机配置。</span>
        <button type="button" className="dns-btn danger" onClick={resetAll}>
          恢复全部默认
        </button>
      </div>
    </div>
  )
}
