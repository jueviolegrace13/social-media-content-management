/**
 * Minimal Neon AI Gateway client (experimental, isolated).
 *
 * AI features are out of scope for the first release (see PLAN.md), so nothing in the
 * app imports this yet. It exists so the gateway wiring is proven and ready when an
 * AI phase starts. Reads NEON_AI_GATEWAY_BASE_URL and NEON_AI_GATEWAY_TOKEN, which
 * `neon deploy` pulls into .env.local.
 */
import { neon } from '@neon/ai-sdk-provider'
import { generateText } from 'ai'

export interface GatewayModel {
  id: string
  name?: string
  owned_by?: string
  enabled?: boolean
  unavailable_reason?: string
}

function gatewayEnv() {
  const baseUrl = process.env.NEON_AI_GATEWAY_BASE_URL
  const token = process.env.NEON_AI_GATEWAY_TOKEN
  if (!baseUrl || !token) {
    throw new Error('NEON_AI_GATEWAY_BASE_URL and NEON_AI_GATEWAY_TOKEN must be set (run `neon deploy`).')
  }
  return { baseUrl: baseUrl.replace(/\/+$/, ''), token }
}

/** Lists the models the gateway exposes on the linked branch (GET /v1/models). */
export async function listGatewayModels(): Promise<GatewayModel[]> {
  const { baseUrl, token } = gatewayEnv()
  const res = await fetch(`${baseUrl}/v1/models`, { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) throw new Error(`Listing models failed: HTTP ${res.status}`)
  const body = (await res.json()) as { data?: GatewayModel[] }
  return body.data ?? []
}

/** One plain text completion through the gateway. */
export async function generateGatewayText(modelId: string, prompt: string): Promise<string> {
  gatewayEnv()
  const { text } = await generateText({ model: neon(modelId), prompt })
  return text
}
