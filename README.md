# Helium Discord Bot Backend

Helium is the backend repository for the Lumin Discord bot. The bot's default Discord display name is `Lumin`; `BOT_NAME` is the single environment-driven override used by user-facing prompts. The web console is maintained as a separate repository and communicates with this backend through `/dashboard` APIs.

## Requirements

- Node.js 20 or newer.
- MongoDB connection string.
- Discord application/bot credentials.
- A Google GenAI API key for supported Gemini models.
- OAuth credentials for each console sign-in provider you enable.

## Local setup

1. Copy `.env.example` to `.env` and replace every placeholder. Never commit `.env`, OAuth secrets, bot tokens, or Google API keys.
2. Install dependencies with `npm install` for local development. Before production deployment, generate/review and commit `package-lock.json`, then use `npm ci` for reproducible installs; the source ZIP had no lockfile and this workspace could not reach the npm registry to generate one.
3. Run `npm run check` and `npm test`.
4. Start with `npm start`. `/` and `/health` report service health; the administrative API is mounted at `/dashboard`.

## Important configuration

- `HELIUM_OWNER_EMAIL` and/or `HELIUM_OWNER_DISCORD_ID`: the environment-only global owner identity.
- `HELIUM_STAFF_ROLES_JSON`: optional bootstrapped staff assignments. Admin and Moderator roles have `superior`, `senior`, and `junior` levels; guild-scoped grants must include guild IDs.
- `GOOGLE_OAUTH_CALLBACK_URL` and `DISCORD_OAUTH_CALLBACK_URL`: exact HTTPS callback URLs, never derived from forwarded headers.
- `HELIUM_CONSOLE_URL` and `HELIUM_CONSOLE_ORIGINS`: separate console deployment URL and exact allowed browser origins. Use `HELIUM_COOKIE_SAME_SITE=None` and `HELIUM_COOKIE_SECURE=true` for truly cross-site deployment. Prefer sibling subdomains under a custom domain to avoid browsers blocking third-party cookies.
- `HELIUM_RECAPTCHA_REQUIRED`, `RECAPTCHA_SITE_KEY`, `RECAPTCHA_SECRET_KEY` and `HELIUM_CONSOLE_HOSTNAMES`: login CAPTCHA settings. In production, the default is required and OAuth login is gated by a short-lived, single-use, provider-bound verification ticket. Configure the exact reCAPTCHA v3 hostnames or login fails closed.
- `HELIUM_ENABLE_ADMIN_TERMINALS=false` and `HELIUM_ENABLE_FILE_EDITOR=false`: dangerous console capabilities remain disabled unless deliberately enabled for an owner-only deployment.
- `HELIUM_ATTACHMENT_ALLOWLIST`: explicit Discord user IDs that may request attachment analysis. Default is deny.
- `HELIUM_REDIS_ENABLED=false`: Redis is not used by memory. If enabled with `REDIS_URL`, Redis is limited to shared rate-limit counters; local bounded rate limiting remains the fallback.

## AI and conversation behavior

- The model list and capabilities are centralized in `modules/config.js`. Mutable model, prompt, and safety settings go through `helium/runtimeRegistry.js`.
- The application persists chat history and sends at most the latest five stored text messages as historical context. System instructions/personality prompts are configured separately.
- Balanced category safety settings are applied when supported by the selected model and the installed Google GenAI SDK. Unsupported model controls are not represented as successfully enforced controls. Gemma model capabilities can differ from Gemini.
- Binary media processing is denied by default. Replies and forwarded-message text are still extracted. Media analysis needs an explicit per-user setting or allowlist entry.
- Complex vector/RAG memory indexing and retrieval are disabled. Existing history and explicit facts remain separate boundaries for a future memory system. Explicit summaries and other unrelated bot features remain available.

## Security model

Authentication uses Google OAuth and Discord OAuth; only recognized owner/staff identities may log in. Sessions are opaque, server-side and stored in HttpOnly cookies. Mutating API calls require the session CSRF token. Every `/dashboard/api` request passes through authentication, a per-action permission policy, bounded rate limiting, CSRF protection for mutations and an audit hook. The public OAuth starts are rate-limited and protected by one-time state plus a required CAPTCHA ticket in production. Owner-only operations remain owner-only even for the most senior staff role.

The current interactive Node, MongoDB and shell terminals are disabled by default. They execute powerful operations and should only be enabled in a private, hardened deployment. File editing is also disabled by default and restricted to the owner.

Read `docs/architecture.md`, `docs/security.md`, `docs/data-policy.md`, `docs/api.md`, and `docs/deployment.md` before production deployment.

## Validation

`npm run check` parses every tracked JavaScript source file except installed dependencies. `npm test` runs the focused security-policy tests. Passing these checks is not a substitute for installing the production dependencies, running integration tests against a disposable database, performing external security review, or load-testing the target hosting tier. The Node V8 heap flag is not a hard cap on total process RSS.
