# ADR-0011: Neon AI Gateway as the future model access path (spike)

**Status:** Proposed (2026-11-25)

## Context
AI features are out of scope for the first release. We still want to know how a model call would plug in later,
without adding an AI dependency to any product flow now. The project already uses Neon Postgres, and Neon's
AI Gateway gives branch-scoped access to many models behind one token.

## Decision
- `neon.ts` declares `aiGateway: true`; `neon deploy` pulls `NEON_AI_GATEWAY_BASE_URL` and `NEON_AI_GATEWAY_TOKEN` into `.env.local`.
- One isolated module, `server/lib/aiGateway.ts`, wraps `@neon/ai-sdk-provider` (AI SDK `generateText`) and the `/v1/models` listing.
- Nothing in the app imports it. `npm run ai:smoke [model-id]` lists models and asks one for a short reply.

## Trade-offs
- Adds `ai`, `@neon/ai-sdk-provider`, `@neon/config` and `@neon/env` to dependencies before any feature needs them. They are small and unused at runtime.
- Calls need AI Gateway credits on the Neon account; without them every model reports `paid_plan_required` and calls return 403.
- Ties future AI work to Neon's gateway. The AI SDK keeps the call site provider-neutral, so swapping providers later is a one-line change.
