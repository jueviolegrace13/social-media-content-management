/**
 * Local-only env loading for CLI scripts and the dev servers: `.env.local` first, then `.env`. dotenv never overrides
 * a variable that is already set, so `.env.local` wins over `.env`, and real environment variables (Vercel) win over
 * both. Missing files are ignored. Production code never imports this.
 */
import { config } from 'dotenv'

config({ path: '.env.local', quiet: true })
config({ path: '.env', quiet: true })
