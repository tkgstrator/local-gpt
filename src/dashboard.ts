import { CapabilitiesSchema } from './capabilities'
import { z } from 'zod'
z.config({ jitless: true })
const HealthSchema = z.object({
  status: z.literal('ok'),
  browserConnected: z.boolean(),
  transport: z.enum(['websocket', 'http']).nullable(),
  busy: z.boolean(),
  updating: z.boolean().optional(),
  browsers: z.number().int().nonnegative().optional(),
  availableBrowsers: z.number().int().nonnegative().optional(),
  wsPort: z.number(),
})
function element<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id)
  if (!node) throw new Error(`Missing dashboard element: ${id}`)
  return node as T
}
let updating = false
let capabilitiesUpdating = false
let wasConnected = false
function clearCapabilities() {
  element('account-plan').textContent = '未取得'
  element('capability-models').replaceChildren()
  element('capability-detail').textContent = 'ChatGPTの接続後に情報を取得します。'
}
async function refreshCapabilities() {
  if (capabilitiesUpdating) return
  capabilitiesUpdating = true
  const button = element<HTMLButtonElement>('refresh-capabilities')
  button.disabled = true
  try {
    const response = await fetch('/v1/capabilities', {
      cache: 'no-store',
      signal: AbortSignal.timeout(12000),
    })
    if (!response.ok) throw new Error('Capabilities unavailable')
    const data = CapabilitiesSchema.parse((await response.json()) as unknown)
    if (!wasConnected) {
      clearCapabilities()
      return
    }
    const labels: Record<string, string> = {
      pro: 'Pro',
      plus: 'Plus',
      free: 'Free',
      team: 'Business',
      business: 'Business',
      enterprise: 'Enterprise',
      edu: 'Edu',
      go: 'Go',
    }
    element('account-plan').textContent = data.plan
      ? data.planTier
        ? `Pro ${data.planTier}`
        : (labels[data.plan] ?? data.plan)
      : '未取得'
    const rows = (data.models ?? []).map((model) => {
      const row = document.createElement('tr')
      for (const value of [
        model.name + ' (' + model.id + ')',
        model.reasoning ?? '情報なし',
        model.efforts.length
          ? model.efforts.map((e) => e.label).join(' / ')
          : model.configurable
            ? '情報なし'
            : '変更不可',
      ]) {
        const cell = document.createElement('td')
        cell.className = 'px-6 py-4 text-xs'
        cell.textContent = value
        row.append(cell)
      }
      return row
    })
    element('capability-models').replaceChildren(...rows)
    const capabilitiesLoaded = data.models !== null && data.plan !== null
    element('capability-detail').textContent = capabilitiesLoaded
      ? `ChatGPTのAPI応答から取得 · ${new Date(data.observedAt!).toLocaleTimeString('ja-JP')} · ${rows.length}モデル`
      : '未取得の情報があります。拡張機能を更新してChatGPTを再読み込みし、情報を更新してください。'
  } catch {
    clearCapabilities()
    element('capability-detail').textContent =
      '取得できませんでした。ChatGPTの接続を確認して、情報を更新してください。'
  } finally {
    capabilitiesUpdating = false
    button.disabled = false
  }
}
element('refresh-capabilities').addEventListener('click', () => {
  void refreshCapabilities()
})
let toastTimer: ReturnType<typeof setTimeout> | undefined
async function refresh() {
  if (updating) return
  updating = true
  const button = element<HTMLButtonElement>('refresh-status')
  button.disabled = true
  try {
    const response = await fetch('/health', {
      cache: 'no-store',
      signal: AbortSignal.timeout(4000),
    })
    if (!response.ok) throw new Error('Health request failed')
    const health = HealthSchema.parse((await response.json()) as unknown)
    if (!health.browserConnected) clearCapabilities()
    if (health.browserConnected && !health.busy) void refreshCapabilities()
    wasConnected = health.browserConnected
    element('server-status').textContent = '稼働中'
    element('browser-status').textContent = health.browserConnected ? '接続済み' : '接続待ち'
    element('browser-detail').textContent =
      health.transport === 'websocket'
        ? `WebSocket · ポート${health.wsPort}`
        : health.transport === 'http'
          ? `HTTP · ポート8766${health.browsers ? ` · ${health.browsers}タブ` : ''}`
          : 'ChatGPTでスクリプトを有効にしてください'
    element('request-status').textContent = health.updating
      ? '更新中'
      : health.availableBrowsers !== undefined && health.browsers && health.browsers > 1
        ? `${health.browsers - health.availableBrowsers}件処理中 · ${health.availableBrowsers}タブ受付可能`
        : health.busy
          ? '処理中'
          : health.browserConnected
            ? '受付可能'
            : '接続後に受付'
    element('connection-notice').dataset.state = health.browserConnected ? 'ready' : 'waiting'
    element('notice-title').textContent = health.browserConnected
      ? health.updating
        ? '拡張機能を更新しています'
        : health.busy
          ? 'ChatGPTが回答を生成しています'
          : '接続できました。APIを利用できます。'
      : 'サーバーは起動しています。ブラウザーの接続を待っています。'
    element('notice-detail').textContent = health.browserConnected
      ? 'このページを開いたまま、接続したChatGPTのタブも開いておいてください。'
      : '上の手順でスクリプトを保存し、ChatGPTを再読み込みしてください。'
    element('updated-at').textContent =
      `最終確認 ${new Intl.DateTimeFormat('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date())} · 5秒ごとに更新`
  } catch {
    wasConnected = false
    clearCapabilities()
    element('server-status').textContent = '確認できません'
    element('browser-status').textContent = '状態不明'
    element('request-status').textContent = '状態不明'
    element('browser-detail').textContent = 'サーバーとの接続を確認してください'
    element('connection-notice').dataset.state = 'error'
    element('notice-title').textContent = 'ローカルサーバーの状態を取得できません'
    element('notice-detail').textContent =
      'サーバーが起動していることを確認して「接続を更新」を押してください。'
    element('updated-at').textContent = '最新の状態を取得できませんでした'
  } finally {
    updating = false
    button.disabled = false
  }
}
async function copyText(text: string) {
  if (navigator.clipboard) {
    await navigator.clipboard.writeText(text)
    return
  }
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.style.cssText = 'position:fixed;left:-9999px'
  document.body.append(textarea)
  textarea.select()
  const copied = document.execCommand('copy')
  textarea.remove()
  if (!copied) throw new Error('Clipboard unavailable')
}
element('refresh-status').addEventListener('click', () => {
  void refresh()
  void refreshLocalMcp()
})
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-copy]'))
  button.addEventListener('click', () => {
    const text =
      button.dataset.copy === 'extensions'
        ? 'chrome://extensions/'
        : button.dataset.copy === 'endpoint'
          ? `${location.origin}/v1/responses`
          : element('request-example').textContent || ''
    void copyText(text).then(
      () => feedback('コピーしました'),
      () => feedback('コピーできませんでした。テキストを選択してコピーしてください。'),
    )
  })
function feedback(message: string) {
  const toast = element('copy-feedback')
  toast.textContent = message
  toast.style.opacity = '1'
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    toast.style.opacity = '0'
  }, 2500)
}
void refresh()
const interval = setInterval(() => {
  if (!document.hidden) {
    void refresh()
    void refreshLocalMcp()
  }
}, 5000)
window.addEventListener(
  'pagehide',
  () => {
    clearInterval(interval)
    if (toastTimer) clearTimeout(toastTimer)
  },
  { once: true },
)

for (const button of document.querySelectorAll<HTMLButtonElement>('[data-installer]'))
  button.addEventListener('click', () => {
    const extension = button.dataset.installer === 'extension'
    element('install-extension').hidden = !extension
    element('install-userscript').hidden = extension
    for (const option of document.querySelectorAll<HTMLButtonElement>('[data-installer]'))
      option.setAttribute('aria-pressed', String(option === button))
  })

const LocalMcpStatusSchema = z.object({
  configured: z.boolean(),
  connected: z.boolean(),
  endpoint: z.string().optional(),
  tools: z.array(z.string()),
  error: z.string().nullable().optional(),
  chatgptConnection: z.literal('not_verified'),
})
let localMcpUpdating = false
async function refreshLocalMcp() {
  if (localMcpUpdating) return
  localMcpUpdating = true
  const button = element<HTMLButtonElement>('refresh-localmcp')
  button.disabled = true
  try {
    const response = await fetch('/v1/localmcp', {
      cache: 'no-store',
      signal: AbortSignal.timeout(12000),
    })
    if (!response.ok) throw Error('unavailable')
    const data = LocalMcpStatusSchema.parse(await response.json())
    element('localmcp-status').textContent = data.connected
      ? '接続済み'
      : data.configured
        ? '接続できません'
        : '未設定'
    element('localmcp-detail').textContent = data.connected
      ? `LocalMCP · ${data.tools.length}ツール`
      : '設定とサイドカーの起動状態を確認してください。'
  } catch {
    element('localmcp-status').textContent = '接続を確認できません'
    element('localmcp-detail').textContent = 'サーバーとの接続を確認してください。'
  } finally {
    button.disabled = false
    localMcpUpdating = false
  }
}
element('refresh-localmcp').addEventListener('click', () => {
  void refreshLocalMcp()
})
void refreshLocalMcp()
