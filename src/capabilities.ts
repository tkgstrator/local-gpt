import { z } from 'zod'
z.config({ jitless: true })
const Text = z.string().min(1).max(200)
export const CapabilityModelSchema = z.object({
  id: Text,
  name: Text,
  reasoning: Text.nullable(),
  configurable: z.boolean(),
  efforts: z.array(z.object({ id: Text, label: Text })).max(20),
})
export const ModelChoiceSchema = z.object({
  model: Text,
  version: Text,
  versionLabel: Text,
  title: Text,
  effort: Text.nullable(),
  index: z.number().int().min(0).max(29),
  count: z.number().int().min(1).max(30),
})
export const CapabilitiesSchema = z.object({
  models: z.array(CapabilityModelSchema).max(100).nullable(),
  choices: z.array(ModelChoiceSchema).max(300).default([]),
  plan: Text.nullable(),
  planTier: z.enum(['100', '200', '500']).nullable().default(null),
  observedAt: z.string().datetime().nullable(),
  source: z.literal('chatgpt_api'),
  selectionSupported: z.boolean(),
})
export type Capabilities = z.infer<typeof CapabilitiesSchema>
export const emptyCapabilities = (): Capabilities => ({
  models: null,
  choices: [],
  plan: null,
  planTier: null,
  observedAt: null,
  source: 'chatgpt_api',
  selectionSupported: false,
})
const ModelsResponse = z.object({
  models: z
    .array(
      z.object({
        slug: Text,
        title: Text,
        reasoning_type: Text.optional(),
        configurable_thinking_effort: z.boolean().optional(),
        thinking_efforts: z
          .array(z.object({ thinking_effort: Text, short_label: Text }))
          .max(20)
          .optional(),
        is_work_mode_model: z.boolean().optional(),
      }),
    )
    .max(100),
  versions: z
    .array(
      z.object({
        id: Text.optional(),
        display_text_for_intelligence: Text.optional(),
        enabled: z.boolean(),
        intelligence_presets: z
          .array(
            z.object({
              model_slug: Text,
              preset_type: Text,
              title: Text.optional(),
              thinking_effort: Text.optional(),
            }),
          )
          .max(30),
      }),
    )
    .max(30),
})
const AccountResponse = z.object({
  accounts: z.record(
    z.string(),
    z.object({
      account: z.object({ plan_type: Text.optional() }),
      entitlement: z.object({ subscription_plan: Text.optional() }).nullable().optional(),
    }),
  ),
  account_ordering: z.array(z.string()).optional(),
})
export function normalizeModels(value: unknown): Capabilities['models'] {
  const parsed = ModelsResponse.safeParse(value)
  if (!parsed.success) return null
  const allowed = new Set(
    parsed.data.versions
      .filter((v) => v.enabled)
      .flatMap((v) =>
        v.intelligence_presets
          .filter((p) => p.preset_type === 'available')
          .map((p) => p.model_slug),
      ),
  )
  return parsed.data.models
    .filter((m) => allowed.has(m.slug) && !m.is_work_mode_model)
    .map((m) => ({
      id: m.slug,
      name: m.title,
      reasoning: m.reasoning_type ?? null,
      configurable: m.configurable_thinking_effort ?? false,
      efforts: (m.thinking_efforts ?? []).map((e) => ({
        id: e.thinking_effort,
        label: e.short_label,
      })),
    }))
}
export function normalizeChoices(value: unknown): Capabilities['choices'] {
  const parsed = ModelsResponse.safeParse(value)
  if (!parsed.success) return []
  const chatModels = new Set(
    parsed.data.models.filter((m) => !m.is_work_mode_model).map((m) => m.slug),
  )
  return parsed.data.versions
    .filter((v) => v.enabled && v.id && v.display_text_for_intelligence)
    .flatMap((v) =>
      v.intelligence_presets.flatMap((p, index) =>
        p.preset_type === 'available' && p.title && chatModels.has(p.model_slug)
          ? [
              {
                model: p.model_slug,
                version: v.id!,
                versionLabel: v.display_text_for_intelligence!,
                title: p.title,
                effort: p.thinking_effort ?? null,
                index,
                count: v.intelligence_presets.length,
              },
            ]
          : [],
      ),
    )
}
export function normalizePlanDetails(
  value: unknown,
  accountId?: string | null,
): Pick<Capabilities, 'plan' | 'planTier'> {
  const parsed = AccountResponse.safeParse(value)
  const unknown = { plan: null, planTier: null }
  if (!parsed.success) return unknown
  const accounts = parsed.data.accounts
  const ids = Object.keys(accounts)
  const current = accountId
    ? accounts[accountId]
    : (accounts.default ?? (ids.length === 1 ? accounts[ids[0]!] : undefined))
  if (!current) return unknown
  const subscription = current.entitlement?.subscription_plan
  // Confirmed against ChatGPT's numbered-tier label mapping, not invoice amounts.
  const tiers: Record<string, '100' | '200' | '500'> = {
    chatgptprolite: '100',
    chatgptprolite_partner_managed: '100',
    chatgptprolitefreeplan_with_expiration: '100',
    chatgptpro: '200',
    chatgptproplan: '200',
    chatgptpro_partner_managed: '200',
    chatgptprofreeplan: '200',
    chatgptprofreeplan_with_expiration: '200',
    chatgptpromax: '500',
    chatgptpromaxfreeplan_with_expiration: '500',
  }
  return {
    plan: current.account.plan_type ?? null,
    planTier: subscription ? (tiers[subscription] ?? null) : null,
  }
}
export function normalizePlan(value: unknown, accountId?: string | null): string | null {
  return normalizePlanDetails(value, accountId).plan
}
export const CAPABILITY_EVENT = 'localgpt:capabilities'
export const CAPABILITY_REQUEST = 'localgpt:capabilities-request'

export const TURN_EVENT = 'localgpt:submitted-turn'
export const SubmittedTurnSchema = z.object({
  messageId: z.string().uuid(),
  conversationId: z.string().uuid().nullable(),
})
