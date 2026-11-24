/**
 * Smoke test for the Neon AI Gateway: lists the branch's models, then asks one of them
 * for a short reply. Usage: `npm run ai:smoke [model-id]`. Never prints the token.
 */
import { config } from 'dotenv'
config({ path: '.env.local' })
config()

const { listGatewayModels, generateGatewayText } = await import('../server/lib/aiGateway.js')

const models = await listGatewayModels()
const enabled = models.filter((m) => m.enabled !== false)
console.log(`Models on this branch: ${models.length} (${enabled.length} enabled)`)
for (const m of models) {
  console.log(`  ${m.enabled === false ? '-' : '+'} ${m.id}${m.unavailable_reason ? ` (${m.unavailable_reason})` : ''}`)
}

const requested = process.argv[2]
const preferred = ['claude-haiku-4-5', 'gemini-3-flash']
const modelId =
  requested ?? preferred.find((id) => enabled.some((m) => m.id === id)) ?? enabled[0]?.id

if (!modelId) {
  console.error('No enabled models. AI Gateway needs credits on the Neon Billing page before models can be called.')
  process.exit(1)
}

const reply = await generateGatewayText(modelId, 'In one short sentence, say hello to a pickleball club owner.')
console.log(`\nReply from ${modelId}:\n${reply}`)
