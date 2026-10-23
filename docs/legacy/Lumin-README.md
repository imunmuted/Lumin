<div align="center">

```
██╗     ██╗   ██╗███╗   ███╗██╗███╗   ██╗
██║     ██║   ██║████╗ ████║██║████╗  ██║
██║     ██║   ██║██╔████╔██║██║██╔██╗ ██║
██║     ██║   ██║██║╚██╔╝██║██║██║╚██╗██║
███████╗╚██████╔╝██║ ╚═╝ ██║██║██║ ╚████║
╚══════╝ ╚═════╝ ╚═╝     ╚═╝╚═╝╚═╝  ╚═══╝
```

**An intelligent Discord bot powered by Google Gemini & Gemma AI**  
*Your AI-powered server companion — remembers, responds, and acts on your behalf*

[![Node.js](https://img.shields.io/badge/Node.js-20%2B-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)
[![Discord.js](https://img.shields.io/badge/Discord.js-v14-5865F2?style=flat-square&logo=discord&logoColor=white)](https://discord.js.org)
[![MongoDB](https://img.shields.io/badge/MongoDB-Atlas-47A248?style=flat-square&logo=mongodb&logoColor=white)](https://mongodb.com)
[![Gemini](https://img.shields.io/badge/Google-Gemini_AI-4285F4?style=flat-square&logo=google&logoColor=white)](https://ai.google.dev)
[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE.md)
[![Version](https://img.shields.io/badge/version-3.1.0-orange?style=flat-square)]()

</div>

---

## What is Lumin?

Lumin is a full-featured AI Discord companion built around Google Gemini and Gemma. It maintains persistent per-user and per-server conversation memory using a RAG pipeline backed by MongoDB Atlas Vector Search, runs a rolling session summary system to prevent bot amnesia over long histories, supports multimodal file and image analysis, ships 28 autonomous function tools, a complete interactive game system, and exposes a real-time admin dashboard secured via Google OAuth.

Slash commands are registered automatically on every startup — no separate deploy step needed.

---

## Features

### AI & Conversation

- **Persistent RAG Memory** — Every reply is grounded by a vector search over past conversations. Lumin generates 3072-dimensional embeddings (`gemini-embedding-2`) and retrieves semantically relevant history before each response. A K-means cluster engine accelerates search as memory grows.
- **Personal Memory** — Lumin proactively saves facts about each user (hobbies, preferences, life details) via the `manage_personal_memory` function tool and recalls them naturally across all servers and DMs.
- **Server Facts** — A shared knowledge layer for every guild. Lumin automatically stores and retrieves server-wide facts — relationships, nicknames, roles, recurring activities, events, and more — via `manage_server_fact`, categorised and scoped to the guild.
- **Cross-Context Memory** — Opt-in feature that lets Lumin carry memories and server facts across every server a user shares with it, and across DMs.
- **Automatic Tool Calling** — 28 native function tools Lumin calls on its own judgement, grouped by category:

  | Category | Tools |
  |---|---|
  | Memory | `manage_personal_memory`, `manage_server_fact`, `search_memory`, `check_sessions` |
  | Scheduling | `set_reminder`, `set_birthday`, `set_timezone`, `check_time_elapsed`, `get_message_timestamp`, `get_current_datetime` |
  | Media / Expression | `search_gif`, `get_server_emojis`, `get_server_stickers`, `fetch_meme`, `search_giphy_sticker` |
  | Discord Actions | `check_user_profile`, `create_poll`, `send_dm`, `send_server_message`, `edit_bot_message`, `delete_bot_message`, `pin_message`, `create_thread`, `add_reaction` |
  | Information | `get_server_info`, `get_channel_info` |
  | Search | `google_search` *(Gemma-only)* |
  | Moderation | `ignore_user` |
- **Web Search** — Native Gemini grounding lets Lumin pull live web results into any reply.
- **Multimodal Input** — Attach images, PDFs, and documents in chat. Video and audio processing are available behind feature flags. Files are processed via the Gemini Files API and optionally embedded into memory.
- **Custom Personalities** — Each user and server can set their own system prompt that shapes how Lumin responds.
- **Response Formats** — Toggle between plain text and Discord embed responses, per-user or per-server.

### Multi-Model Support

Users can pick their preferred model from settings. Available models:

| Model key | Description |
|---|---|
| `gemini-3.1-pro` | Most capable Gemini 3, agentic tasks |
| `gemini-3.1-flash-lite` | Fastest / cheapest Gemini 3 (default) |
| `gemini-3-flash` | Frontier-class at a fraction of the cost |
| `gemini-3.5-flash` | Speed + quality balance |
| `gemini-2.5-pro` | Best reasoning and coding |
| `gemma-4-26b` | MoE 26B active params |
| `gemma-4-31b` | Dense 31B Gemma 4 |
| `gemma-3-27b` | Gemma 3 27B |
| `gemma-3-12b` | Gemma 3 12B |
| `gemma-3-4b` | Gemma 3 4B |
| `gemma-3-2b` | Gemma 3 2B |
| `gemma-3-1b` | Gemma 3 1B |

**Gemma modes** (configured in `modules/config.js`):
- `ENABLE_GEMMA=true` — routes all standard chat through Gemma exclusively; Gemini is never used.
- `CYCLE_GEMMA_WITH_GEMINI=true` — Gemini runs first; Gemma models are appended to the fallback chain after all Gemini keys are exhausted.

### Multi-Key Rotation

Add as many Gemini API keys as you like (`GOOGLE_API_KEY1`, `GOOGLE_API_KEY2`, …). The `ApiKeyManager` detects rate-limit responses, cools down the affected key, and rotates to the next automatically. A per-key daily cap is enforced for Gemma models.

### Reliability Infrastructure

- **Circuit Breaker** — The `core/CircuitBreaker` trips when the AI API is consistently failing and holds new requests off until the upstream recovers, preventing a cascade of failed calls.
- **Per-User Queue** — Every user gets their own message queue (configurable depth). Messages beyond the cap are dropped with a warning rather than stacking up.
- **Structured Error Hierarchy** — `core/AppError` gives every error type its own class (`RateLimitError`, `CircuitOpenError`, etc.) for clean catch blocks and logging.
- **Retry Utilities** — Shared `retryUtils` with exponential backoff used across all commands and AI calls.

---

## Slash Commands

| Command | Description |
|---|---|
| `/settings` | Open the user or server settings panel |
| `/search [prompt] [file]` | AI-powered web search; optionally attach a file |
| `/summary [link] [count]` | Summarise recent Discord messages or a YouTube link |
| `/reminder` | Set one-time, daily, weekly, or monthly reminders |
| `/birthday` | Track and announce server member birthdays |
| `/quote` | Schedule or fetch daily inspirational quotes |
| `/digest` | AI-generated digest of recent server activity |
| `/compliment [user]` | Send an anonymous compliment to someone |
| `/reaction` | Configure Lumin's random reaction roulette on messages |
| `/details` | View Lumin's server anniversary and join info |
| `/starter` | Generate AI conversation starters for the server |
| `/timezone` | Set your timezone (required for time-sensitive features) |
| `/game` | Launch an interactive game (see below) |
| `/schedule [action]` | Auto-send messages to revive inactive channels |

### Games (`/game`)

| Game | Description |
|---|---|
| Truth, Dare, or Situation | AI-generated truth questions, dares, or hypothetical scenarios |
| Never Have I Ever | Rotating NHIE prompts with a next button |
| Would You Rather | Difficult AI-generated dilemma choices |
| Akinator | Lumin guesses who or what you're thinking of |

---

## Settings

### User Settings (`/settings`)

| Setting | Description |
|---|---|
| Response format | Toggle between normal text and Discord embed responses |
| Action buttons | Show/hide quick-action buttons on replies |
| Continuous reply | Keep Lumin responding without needing another mention |
| Cross-context memory | Share memories and facts across all servers |
| Custom embed color | Set your personal accent color for embeds |
| Custom personality | Write your own system prompt for Lumin |
| Clear history | Wipe your personal conversation history |
| Export history | Download your conversation logs |

### Server Settings (`/settings` — admins only)

| Setting | Description |
|---|---|
| Response format | Override format for the whole server |
| Action buttons | Toggle action buttons server-wide |
| Override user settings | Force server settings to take priority over user preferences |
| Continuous reply | Enable/disable server-wide continuous reply |
| Server chat history | Toggle shared server conversation history tracking |
| Custom embed color | Set a server-wide accent color for embeds |
| Custom personality | Write a server-wide system prompt |
| Export server history | Download or archive the server's conversation logs |

---

## Admin Dashboard (LuminDash)

Access at `/dashboard` on your deployment URL.

**Authentication:** Google OAuth 2.0 — only the authorised account can log in. reCAPTCHA v3 runs silently in the background.

**Real-time stats** (WebSocket, 1-second updates): ping, memory usage, uptime, server count, disk usage.

**Terminals:**
- Live Node.js REPL — execute JavaScript on the running instance
- Live MongoDB shell — query your database in-browser

**Admin commands available in the dashboard:**

| Category | Commands |
|---|---|
| State | Force save, reload state |
| API keys | View stats, switch active key, switch to specific key index |
| Users | Blacklist, unblacklist, view blacklist, clear history, view profile, resolve username, send DM |
| Servers | List servers, view settings, reset server, guild info, leave server |
| Usage | Clear image usage, clear summary usage, clear quote usage, clear starter usage, clear compliment usage |
| Reminders | View all reminders, clear reminders |
| Birthdays | View all birthdays, clear birthdays |
| Broadcast | Announce to all servers, announce to all users (DM), send to specific channel |
| Members | Kick member, ban member, set nickname |
| Bot presence | Set activity/status, get current presence |
| Config | Reload slash commands, toggle debug mode |
| Global | Lockdown toggle (stops the bot responding everywhere instantly), restart |

---

## Memory Architecture

```
User message
     │
     ▼
EmbeddingService  ──►  3072-dim vector (gemini-embedding-exp-03-07)
     │
     ▼
MemorySystem ──► L1 in-process LRU cache
             ──► L2 semantic similarity cache
             ──► L3 Redis cache (if REDIS_URL is set)
             ──► MongoDB Atlas Vector Search (persistent)
             │
             ▼
         ClusterEngine  ── K-means clustering for fast nearest-neighbour
             │
             ▼
         Top-N results injected into prompt context
```

### Session Memory

To solve bot amnesia over long conversation histories, Lumin runs a rolling session summary system on top of the RAG pipeline:

- **Trigger** — Every 50 bot messages per `(userId, historyId)` pair, the previous 50-message window is summarised.
- **First-person voice** — Summaries are written as Lumin recalling what happened ("I helped Alex debug…"), keeping them natural when injected back into context.
- **Single living document** — Rather than appending new docs, the existing session summary for that conversation is fetched, the new window is merged in, and the single document is updated in place — one doc per conversation, always current.
- **Dual search tools** — `search_memory` covers the last 24 hours of history; `check_sessions` runs a separate vector search over older session summaries (days/weeks back), so Lumin can recall things said long ago without blowing up the context window.
- **Daily digest collapse** — After 24 hours the `WeeklySummaryJob` / daily digest collapses old per-session entries into a single consolidated entry, keeping the database lean.
- **Redis TTL** — Active session state is cached in Redis with a 25-hour TTL for fast reads; MongoDB is the durable store.

RAG can be run in two modes (set in `modules/config.js`):
- `ENABLE_RAG=true` — automatic vector search before every reply
- `ENABLE_RAG=false` (default) — AI calls `search_memory` / `check_sessions` as tools on its own judgement

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 20+ (ESM) |
| Discord | Discord.js v14 |
| AI | Google Gemini & Gemma (`@google/genai`) |
| Database | MongoDB Atlas |
| Vector Search | MongoDB Atlas Vector Search |
| Caching | LRU-cache (L1/L2) + Redis (L3, optional) |
| Dashboard | Express.js 5 + native WebSocket |
| Auth | Google OAuth 2.0 + reCAPTCHA v3 |
| Media | sharp (images), fluent-ffmpeg (video/audio), office-text-extractor (docs) |
| Scheduling | node-cron |
| Hosting | Render (or any Node-compatible host) |

---

## Project Structure

```
lumin/
├── index.js                      # Entry point — Discord client, Express server, command registration
├── commands.js                   # Slash command definitions (auto-registered on startup)
├── config.js                     # Bot personality, activities, core system rules
├── database.js                   # Re-export shim for database/
│
├── managers/
│   ├── BotManager.js             # Client init, state facade, Gemini proxy
│   ├── ApiKeyManager.js          # Multi-key rotation, rate-limit tracking, Gemma limits
│   ├── QueueManager.js           # Per-user message queues
│   └── StateManager.js           # In-memory state + DB persistence
│
├── modules/
│   ├── message/
│   │   ├── MessageProcessor.js   # Core message pipeline + queue processing
│   │   ├── PromptBuilder.js      # System prompt assembly (personality + memory + context)
│   │   ├── ResponseHandler.js    # Reply formatting, chunking, embed building
│   │   ├── HistoryManager.js     # Per-user/server chat history management
│   │   └── MediaHandler.js       # Attachment detection and routing
│   ├── attachments/
│   │   ├── FileUploader.js       # Gemini Files API upload pipeline
│   │   ├── FileValidator.js      # MIME type + size validation
│   │   └── FileConverter.js      # Format conversion (ffmpeg / sharp)
│   ├── settings/
│   │   ├── UserSettingsHandler.js   # User settings Discord UI
│   │   ├── ServerSettingsHandler.js # Server settings Discord UI
│   │   ├── SettingsRouter.js        # Settings interaction routing
│   │   └── ActionHandlers.js        # Settings button/modal handlers
│   ├── functions/
│   │   ├── FunctionRegistry.js   # Gemini tool declarations (28 tools)
│   │   └── FunctionExecutor.js   # Tool call dispatch and execution
│   ├── shared/
│   │   ├── embedBuilder.js       # Shared embed + component builders
│   │   ├── messageFormatter.js   # Text formatting helpers
│   │   ├── buttonHandlers.js     # Reusable button row builders
│   │   ├── discordHelpers.js     # Shared Discord utility functions
│   │   ├── retryUtils.js         # Exponential backoff retry wrapper
│   │   ├── tempFileManager.js    # Temp file lifecycle management
│   │   └── runtimeFlags.js       # Live feature flag toggles
│   └── config.js                 # Module-level feature flags and constants
│
├── commands/
│   ├── index.js                  # Command + interaction router
│   ├── search.js                 # /search handler
│   ├── timezone.js               # /timezone handler
│   ├── realive.js                # /schedule (chat revival) handler
│   ├── birthday/
│   │   ├── BirthdayHandler.js    # /birthday interactive UI
│   │   └── BirthdayScheduler.js  # Daily birthday check cron
│   ├── reminder/
│   │   ├── ReminderHandler.js    # /reminder interactive UI
│   │   └── ReminderScheduler.js  # Reminder delivery cron
│   ├── quote/
│   │   ├── QuoteHandler.js       # /quote interactive UI
│   │   └── QuoteScheduler.js     # Daily quote delivery cron
│   ├── summary/
│   │   ├── SummaryHandler.js     # /summary command entry
│   │   ├── SummaryExecutor.js    # Summarisation logic (messages + YouTube)
│   │   ├── SessionSummaryJob.js  # Rolling 50-msg session memory summariser
│   │   └── WeeklySummaryJob.js   # Scheduled weekly digest job
│   ├── fun/
│   │   ├── RouletteHandler.js    # /reaction (message reaction roulette)
│   │   ├── DigestHandler.js      # /digest
│   │   ├── AnniversaryHandler.js # /details (server anniversary)
│   │   ├── StarterHandler.js     # /starter
│   │   └── ComplimentHandler.js  # /compliment
│   └── game/
│       ├── GameRouter.js         # /game menu + routing
│       ├── TruthDareSnap.js      # Truth / Dare / Situation
│       ├── NeverHaveIEver.js     # Never Have I Ever
│       ├── WouldYouRather.js     # Would You Rather
│       ├── Akinator.js           # Akinator
│       └── gameUtils.js          # Shared game helpers
│
├── memory/
│   ├── MemorySystem.js           # RAG pipeline facade
│   ├── EmbeddingService.js       # Gemini embeddings (3072-dim) + MRL
│   ├── ClusterEngine.js          # K-means clustering for vector search
│   ├── MemoryStore.js            # Background indexing and store management
│   ├── MemoryCache.js            # L1/L2 in-process semantic cache
│   ├── RedisCache.js             # L3 Redis cache
│   ├── config.js                 # Memory subsystem constants
│   └── memoryUtils.js            # Shared memory helpers
│
├── database/
│   ├── connection.js             # MongoDB connection + collection registry
│   ├── index.js                  # Barrel export
│   ├── batchSave.js              # Batched write helper
│   ├── indexManager.js           # Atlas index management
│   ├── vectorSearch.js           # Atlas Vector Search query helpers
│   └── collections/
│       ├── settingsRepo.js       # User & server settings CRUD
│       ├── historyRepo.js        # Chat history CRUD
│       ├── memoryRepo.js         # Memory entry CRUD
│       ├── usageRepo.js          # Usage tracking (images, quotes, etc.)
│       └── featuresRepo.js       # Per-guild feature flag persistence
│
├── core/
│   ├── AppError.js               # Structured error hierarchy (LuminError, RateLimitError, CircuitOpenError, …)
│   ├── CircuitBreaker.js         # Circuit breaker for the AI API
│   └── Logger.js                 # Structured logger with optional file sink
│
└── dashboard/
    ├── server.js                 # Express router, OAuth, WebSocket, all admin API routes
    └── public/
        ├── index.html            # Dashboard SPA shell
        ├── lumin.png             # Logo / favicon
        ├── css/main.css          # Complete design system
        └── js/
            ├── app.js            # Boot, OAuth flow, real-time stats stream
            ├── config.js         # Token management + page definitions
            ├── router.js         # Client-side navigation
            ├── terminals.js      # xterm.js REPL terminals (Node + Mongo)
            ├── commands.js       # Admin command cards
            ├── servers.js        # Servers page
            ├── announce.js       # Announcement page
            ├── lockdown.js       # Lockdown page
            ├── api.js            # Fetch wrapper
            └── toast.js          # Toast notifications
```

---

## Setup

See [SETUP.md](SETUP.md) for a complete step-by-step guide covering Discord, MongoDB, Google Gemini, Google OAuth, and reCAPTCHA setup.

### Quick start

```bash
git clone https://github.com/your-repo/lumin.git
cd lumin
npm install
# create .env (see SETUP.md)
npm start
```

Lumin registers its slash commands automatically the first time it starts. No separate deploy script is needed.

### Environment variables summary

```env
# Required
DISCORD_BOT_TOKEN=
GOOGLE_API_KEY1=
MONGODB_URI=

# Dashboard (required for LuminDash)
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
RECAPTCHA_SITE_KEY=
RECAPTCHA_SECRET_KEY=
SESSION_SECRET=

# Optional
GOOGLE_API_KEY2=          # add more keys for rotation
REDIS_URL=                # enables L3 Redis cache
LOG_FILE=                 # persist logs to file path
PORT=3000
NODE_ENV=production
```

---

## MongoDB Atlas Vector Search Index

For full semantic RAG to work, create a vector search index named `vector_index` on your `memoryEntries` collection:

```json
{
  "mappings": {
    "dynamic": false,
    "fields": {
      "embedding": {
        "type": "knnVector",
        "dimensions": 3072,
        "similarity": "cosine"
      },
      "metadata.historyId": {
        "type": "string"
      }
    }
  }
}
```

Without this index, Lumin falls back to keyword search — it still works, just without full semantic retrieval.

---

## Configuration

Key flags live in `modules/config.js`:

| Flag | Default | Description |
|---|---|---|
| `DEFAULT_MODEL` | `gemini-3.1-flash-lite` | Model used when user has no preference set |
| `ENABLE_GEMMA` | `true` | Route all chat through Gemma exclusively |
| `CYCLE_GEMMA_WITH_GEMINI` | `false` | Append Gemma to fallback chain after Gemini keys exhaust |
| `ENABLE_RAG` | `false` | Auto-run vector search before every reply (vs. tool-calling mode) |
| `CROSS_CONTEXT_ENABLED` | `false` | Global default for cross-server memory |
| `ENABLE_IMAGE_PROCESSING` | `true` | Accept inline image attachments |
| `ENABLE_VIDEO_PROCESSING` | `false` | Accept video attachments |
| `ENABLE_AUDIO_PROCESSING` | `false` | Accept audio attachments |
| `ENABLE_FILE_PROCESSING` | `false` | Accept generic file attachments |
| `ENABLE_WEB_SEARCH` | `true` | Gemini grounding / web search |
| `ENABLE_FUNCTION_CALLING` | `true` | All tool / function-call use |

Safety settings (all harm categories default to `BLOCK_NONE`) and per-key/per-model rate limits are also tunable in `modules/config.js` and `managers/ApiKeyManager.js`.

---

## Deploying to Render

1. Push your repo to GitHub.
2. Create a new **Web Service** on Render pointing to the repo.
3. **Build command:** `npm install`
4. **Start command:** `npm start`
5. Add all environment variables from the `.env` summary above.
6. Deploy — Render will auto-restart on crashes.

> **Note:** Render's free tier spins down after 15 minutes of inactivity. Use a paid plan if you need reliable reminder and birthday delivery.

---

## License

MIT — see [LICENSE.md](LICENSE.md) for details.

---

<div align="center">
  Built with Node.js · Discord.js · Google Gemini · MongoDB
</div>
