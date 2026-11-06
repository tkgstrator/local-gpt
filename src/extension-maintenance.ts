import {
  MaintenanceTargetSchema,
  MaintenanceGrantSchema,
  type MaintenanceTarget,
  sameTarget,
} from './browser-maintenance'
const ALARM = 'localgpt-connection-watchdog'
const STORAGE = 'localgpt-maintenance-v1'
const SIX_HOURS = 6 * 60 * 60 * 1000
const COOLDOWN = 15 * 60 * 1000
interface RecordState {
  target?: MaintenanceTarget
  loadedAt?: number
  lastAttempt?: number
  attempts?: number[]
  pending?: MaintenanceTarget
  recoveredAt?: number
}
// Bound extension/renderer RPC as well as the network below it. A missing reply is never safety.
export async function bounded<T>(request: Promise<T>, milliseconds = 6500): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      request,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error('LocalGPT connection timed out; pending work is being preserved.')),
          milliseconds,
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
export async function requestMaintenance(token: string, body: unknown): Promise<any> {
  if (!token) throw new Error('Pairing required')
  const response = await fetch('http://127.0.0.1:8766/bridge/maintenance', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Bridge-Token': token },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(4000),
  })
  if (!response.ok) throw new Error('Maintenance unavailable')
  return response.json()
}
export function startMaintenance(token: string) {
  let running = false
  const request = (body: unknown) => requestMaintenance(token, body)
  const send = (target: MaintenanceTarget, message: object) =>
    bounded(
      chrome.tabs.sendMessage(
        target.tabId,
        {
          ...message,
          browserId: target.browserId.slice(String(target.tabId).length + 1),
        },
        { documentId: target.documentId },
      ),
      2000,
    )
  const run = async () => {
    if (running) return
    running = true
    let acquired: { target: MaintenanceTarget; lease: string } | null = null
    let commitIssued = false
    try {
      const probe = await request({ action: 'probe' })
      const parsed = MaintenanceTargetSchema.safeParse(probe.target)
      if (!parsed.success) return
      const target = parsed.data
      const tab = await chrome.tabs.get(target.tabId)
      if (!tab.url || new URL(tab.url).origin !== 'https://chatgpt.com') return
      const safety = await send(target, {
        type: 'localgpt_maintenance_safety',
        deferred: probe.deferred,
      })
      const id = target.browserId.slice(String(target.tabId).length + 1)
      if (!safety || safety.browserId !== id || !Number.isFinite(safety.startedAt)) return
      const state = ((await chrome.storage.local.get(STORAGE))[STORAGE] ?? {}) as RecordState
      const now = Date.now()
      if (!sameTarget(state.target ?? null, target)) {
        state.target = target
        state.loadedAt = Math.min(now, safety.startedAt)
      }
      // A replacement document alone does not prove the recovery worked. Keep the
      // failed-attempt budget until the server observes healthy polling in that replacement.
      if (
        state.pending?.tabId === target.tabId &&
        state.pending.documentId !== target.documentId &&
        probe.connected === true
      ) {
        state.recoveredAt = now
        delete state.pending
        state.attempts = []
      }
      await chrome.storage.local.set({ [STORAGE]: state })
      if (probe.deferred || safety.safe !== true) return
      // A page's age is independent of healthy heartbeats; disconnect recovery uses the same guards.
      if (probe.connected !== false && now - (state.loadedAt ?? now) < SIX_HOURS) return
      const attempts = (state.attempts ?? []).filter((time) => now - time < 24 * 60 * 60 * 1000)
      if (
        (state.lastAttempt !== undefined && now - state.lastAttempt < COOLDOWN) ||
        attempts.length >= 2
      )
        return
      const grant = MaintenanceGrantSchema.safeParse(await request({ action: 'acquire', target }))
      if (!grant.success) return
      const lease = grant.data
      acquired = { target, lease: lease.lease }
      if (lease.expiresAt - Date.now() < 3000) return
      const fresh = await send(target, { type: 'localgpt_maintenance_safety' })
      if (
        !fresh ||
        fresh.browserId !== id ||
        fresh.safe !== true ||
        lease.expiresAt - Date.now() < 2000
      )
        return
      // Persist before the side effect; worker termination or an indeterminate reply cannot cause a loop.
      const previousAttempt = {
        lastAttempt: state.lastAttempt,
        attempts: state.attempts,
        pending: state.pending,
      }
      state.lastAttempt = Date.now()
      state.attempts = [...attempts, state.lastAttempt]
      state.pending = target
      await chrome.storage.local.set({ [STORAGE]: state })
      commitIssued = true
      const outcome = await send(target, {
        type: 'localgpt_maintenance_reload',
        lease: lease.lease,
        expiresAt: lease.expiresAt,
      })
      // Only an explicit completed refusal proves no deferred content commit remains.
      if (outcome?.reloading === false) {
        commitIssued = false
        const current = ((await chrome.storage.local.get(STORAGE))[STORAGE] ?? {}) as RecordState
        if (
          current.lastAttempt === state.lastAttempt &&
          sameTarget(current.pending ?? null, target)
        ) {
          for (const field of ['lastAttempt', 'attempts', 'pending'] as const) {
            const value = previousAttempt[field]
            if (value === undefined) delete current[field]
            else Object.assign(current, { [field]: value })
          }
          await chrome.storage.local.set({ [STORAGE]: current })
        }
      }
    } catch {
      // Server or renderer uncertainty always defers; ordinary bridge reconnects remain independent.
    } finally {
      if (acquired && !commitIssued) {
        try {
          await request({ action: 'cancel', ...acquired })
        } catch {
          /* bounded lease expires */
        }
      }
      running = false
    }
  }
  const ensureAlarm = async () => {
    try {
      const alarm = await chrome.alarms.get(ALARM)
      // Recreating a healthy alarm postpones its next tick on every worker wakeup.
      if (alarm?.periodInMinutes !== 1)
        await Promise.resolve(chrome.alarms.create(ALARM, { periodInMinutes: 1 }))
    } catch {
      /* a later startup/install can restore an unavailable alarm */
    }
  }
  void ensureAlarm()
  chrome.runtime.onStartup.addListener(ensureAlarm)
  chrome.runtime.onInstalled.addListener(ensureAlarm)
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM) void run()
  })
  const invalidate = async (tabId: number) => {
    try {
      const probe = await request({ action: 'probe' })
      const target = MaintenanceTargetSchema.safeParse(probe.target)
      if (target.success && target.data.tabId === tabId)
        await request({ action: 'invalidate', target: target.data })
    } catch {
      /* an unavailable server cannot authorize a reload */
    }
  }
  chrome.tabs.onRemoved.addListener((tabId) => {
    void invalidate(tabId)
  })
  chrome.tabs.onUpdated.addListener((tabId, change) => {
    if (change.status === 'loading') void invalidate(tabId)
  })
  // Exact-document content commit validates this transaction without renewing polling liveness.
  return async (target: MaintenanceTarget, lease: string) =>
    request({ action: 'validate', target, lease })
}
