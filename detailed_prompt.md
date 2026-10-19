# Master Prompt: Complete From-Scratch Architectural Rewrite (Project Helium v4.0.0)

> **Directive**: You are an elite Google Principal Systems Architect & Senior Software Engineer. Your mission is to execute a complete, ground-up rewrite and refactoring of the entire codebase from scratch. Every module, helper, orchestrator, and service must be rewritten with pristine software engineering standards, strict separation of concerns, mathematical cognitive memory, and relentless optimization for high-concurrency environments under strict hardware limits.

---

## 1. Prime Invariants & Non-Negotiables

1. **Zero Code Volume Reduction ($\ge 33,200$ Functional Lines)**
   - The codebase baseline is **33,189 JS lines** (**42,400+ total repository lines**).
   - Under no circumstances may code volume be reduced, simplified away, or replaced with placeholders/stubs (`// TODO`).
   - Every file must be expanded with defensive type guards, error boundaries, rate-limit safety handlers, and comprehensive JSDoc/TSDoc specifications. Do NOT inflate line counts with redundant comments—write deep, robust, functional code.

2. **Zero Personality Alteration & Complete Callsign Parameterization**
   - The bot's identity, extensive character backstory (~35.5k characters), emotional arcs, and authentic Gen Z 2026 texting conventions in `config.js` must be preserved **100% verbatim**.
   - The agent name MUST be dynamically parameterized everywhere via:
     ```javascript
     export const SYSTEM_AGENT_CALLSIGN = (process.env.SYSTEM_AGENT_CALLSIGN || 'Lumin').trim();
     ```
   - Zero hardcoded occurrences of `"Lumin"` in UI labels, modal titles, error cards, prompt instructions, transcript role labels, or settings displays. The project name is `helium` (`v4.0.0-helium`).

3. **Strict Model Restrictions (Only 2 Gemini & 2 Gemma Models)**
   - Only 4 models are permitted in the entire system:
     - **Gemini Primary / Fallback**: `gemini-3.5-flash-lite` (default) and `gemini-3.8-flash` (or preview).
     - **Gemma 4 Models**: `gemma-4-28b` (or `gemma-4-26b-a4b-it`) and `gemma-4-31b` (or `gemma-4-31b-it`).
   - Built-in tool restriction: Built-in `googleSearch: {}` is strictly for Gemini models only. Gemma models receive strictly custom `functionDeclarations`. Gemini search outputs must include clickable markdown citation footers (`[1] [Title](uri)`).

4. **Hardware Ceiling: Render Free Tier (512MB RAM, 0.1 vCPU, 10k Users)**
   - Architecture must safely scale to 10,000 users without crashing.
   - External Redis must remain **OFF by default** (`ENABLE_REDIS = false`).
   - The in-memory cache must implement **Windowed TinyLFU (W-TinyLFU)** with a 4-row 256-column `CountMinSketch` frequency filter and an ironclad 25MB heap ceiling (`FAST_MEMORY_CACHE_MAX_BYTES = 25 * 1024 * 1024`).
   - Discord client caches must be micro-sized: `MessageManager: 10`, `GuildMemberManager: 50`, `UserManager: 100`, `ThreadManager: 10`, `ReactionManager: 5`, with 300s sweepers.
   - Disable libvips image memory buffers: `sharp.cache(false)` and `sharp.concurrency(1)`.

5. **Human-Brain Cognitive Memory Simulation (90%+ Accuracy Target)**
   - Replicate human memory decay using the **Ebbinghaus Forgetting Curve**:
     $$R(\Delta t) = \exp\left(-\frac{\Delta t}{S \cdot \mathcal{I}}\right)$$
     where $\Delta t$ is elapsed time, $S$ is stability potentiated by spaced recalls, and $\mathcal{I} \in [0.5, 3.0]$ is emotional salience.
   - **Spaced Retrieval Potentiation**:
     $$S_{n+1} = S_n \cdot \left(1 + \alpha P e^{-\beta R}\right)$$
   - **Composite Cognitive Ranking**:
     $$F_{\text{rank}} = w_{\text{sim}} \cdot S_{\cos} + w_{\text{ret}} \cdot R(\Delta t) + w_{\text{sal}} \cdot \frac{\mathcal{I}}{2.0}$$
     ($w_{\text{sim}} = 0.60, w_{\text{ret}} = 0.25, w_{\text{sal}} = 0.15$).
   - **Unified Personalization**: Single unified user memory profile across all servers and DMs toggled by `personalization: true` (default `true`).
   - **Zero-Leak Privacy Barrier**: `isFactAdmissible` prevents confidential credentials or private DM disclosures from surfacing in public channels.

---

## 2. Target Layered Architecture

Rewrite the system into strict, decoupled layers:

```
src/ (or root)
 ├── core/                       # Foundational primitives (zero external dependencies)
 │    ├── AppError.js            # Typed hierarchy: HeliumError, RateLimitError, ModelError, etc.
 │    ├── CircuitBreaker.js      # Rolling window three-state breaker
 │    ├── Logger.js              # Leveled structured logger
 │    └── TelemetryWatchdogDaemon.js # RAM & event loop monitor, auto-GC, emergency pruner
 │
 ├── config.js                   # Verbatim personality backstory & rules + SYSTEM_AGENT_CALLSIGN
 ├── modules/config.js           # Single Source of Truth (SSOT) configuration & model capabilities
 │
 ├── database/                   # Data layer & persistence
 │    ├── connection.js          # MongoDB connection pool & reconnection backoff
 │    ├── batchSave.js           # Debounced bulk write orchestrator
 │    ├── vectorSearch.js        # MongoDB $vectorSearch and cosine fallback
 │    └── collections/           # Typed repositories: memoryRepo, settingsRepo, usageRepo, etc.
 │
 ├── memory/                     # Cognitive human-brain memory subsystem
 │    ├── MemorySystem.js        # Orchestrator & Ebbinghaus math facade
 │    ├── MemoryCache.js         # Windowed TinyLFU + CountMinSketch frequency estimator
 │    ├── RedisCache.js          # Optional distributed cache fallback
 │    ├── EmbeddingService.js    # gemini-embedding-2 (768-dim, 64-dim MRL centroid)
 │    ├── ClusterEngine.js       # Fast K-means cluster partitioner
 │    └── MemoryStore.js         # Chunking, indexing, and window sliding
 │
 ├── managers/                   # State, API keys, and bot orchestration
 │    ├── ApiKeyManager.js       # Model fallback state machine & round-robin key rotator
 │    ├── QueueManager.js        # Per-user concurrency queues, token buckets, and rate limits
 │    ├── StateManager.js        # BotState singleton, atomic mutations, and daily resets
 │    └── BotManager.js          # Discord client wiring, micro-caches, and lifecycle
 │
 ├── modules/                    # Application domain logic
 │    ├── message/
 │    │    ├── MessageProcessor.js # Ingestion, queueing, circadian rhythms, temporal anchoring
 │    │    ├── PromptBuilder.js    # Context assembly, RAG injection, token truncation
 │    │    ├── ResponseHandler.js  # Streaming, chunking, citation formatting, GC buffer release
 │    │    └── HistoryManager.js   # Live sliding message history
 │    ├── functions/
 │    │    ├── FunctionRegistry.js # 28 functionDeclaration tool schemas
 │    │    └── FunctionExecutor.js # Parallel dispatch, validation, and execution
 │    └── settings/
 │         ├── SettingsRouter.js       # Interaction dispatcher & blacklist guards
 │         ├── UserSettingsHandler.js  # Components V2 user pages (Personalization toggle)
 │         ├── ServerSettingsHandler.js# Components V2 server pages
 │         └── ActionHandlers.js       # Button, select, and modal callbacks
 │
 ├── commands/                   # Discord interactions & background schedulers
 │    ├── summary/               # SessionSummaryJob (rolling merges) & WeeklySummaryJob
 │    ├── birthday/              # BirthdayHandler & BirthdayScheduler
 │    ├── reminder/              # ReminderHandler & ReminderScheduler
 │    ├── game/                  # Akinator, NeverHaveIEver, Roulette, TruthDare
 │    └── fun/                   # Anniversary, Compliment, Quotes, Realive
 │
 ├── dashboard/                  # Real-time web admin control panel
 │    └── server.js              # Express 5 + WebSockets + metrics API
 │
 └── tests/                      # Comprehensive Vitest verification suite
      ├── config.test.js         # SSOT, models, and tool capability validation
      ├── math.test.js           # Ebbinghaus curves, potentiation, and rank equations
      ├── memoryCache.test.js    # Count-Min Sketch accuracy & W-TinyLFU eviction
      └── telemetry.test.js      # Memory pressure thresholds & emergency eviction hooks
```

---

## 3. Step-by-Step File-by-File Rewrite Plan

### Phase 1: Core Primitives & SSOT Configuration
1. **`core/AppError.js`**:
   - Rewrite the error hierarchy rooted at `HeliumError` (aliasing `LuminError` and `AppError`).
   - Define subclasses: `RateLimitError`, `ModelError`, `CircuitOpenError`, `ValidationError`, `PermissionError`, `DatabaseError`, `AttachmentError`.
   - Implement `classifyApiError(rawError, modelName)` for automatic error classification and retryability detection.
2. **`core/Logger.js`**:
   - Structured JSON logging for production, readable colored logs for development.
   - Pinned levels: `DEBUG`, `INFO`, `WARN`, `ERROR`, `CRITICAL`.
   - Automatic redaction of secrets, tokens, API keys, and passwords.
3. **`core/CircuitBreaker.js`**:
   - Three-state finite state machine (`CLOSED`, `OPEN`, `HALF_OPEN`).
   - Exponential cool-down periods with jitter to prevent thunderous herd hammering.
4. **`core/TelemetryWatchdogDaemon.js`**:
   - High-resolution event loop lag tracking via `perf_hooks`.
   - V8 memory metric sampling every 30s. Calculate $\Phi = 1 - \frac{\text{heapUsed}}{\text{heapTotal}}$.
   - State machine: `NORMAL` ($<70\%$), `ELEVATED` ($70\text{--}85\%$), `CRITICAL` ($\ge 85\%$).
   - Automated invocation of `global.gc()` and dispatch to emergency eviction hooks.
5. **`config.js` & `modules/config.js`**:
   - Export `SYSTEM_AGENT_CALLSIGN`.
   - Preserve all backstory and personality rules verbatim.
   - Define model bounds: `DEFAULT_MODEL = 'gemini-3.5-flash-lite'`, `MODEL_FALLBACK_CHAIN = ['gemini-3.5-flash-lite', 'gemini-3.8-flash']`, `GEMMA_DEFAULT_MODEL = 'gemma-4-28b'`, `GEMMA_FALLBACK_MODEL = 'gemma-4-31b'`.
   - Define `EMBEDDING_MODEL = 'gemini-embedding-2'`, `EMBEDDING_DIM = 768`, `EMBEDDING_MRL_CENTROID_DIM = 64`.
   - Define `ENABLE_REDIS = false`, `FAST_MEMORY_CACHE_MAX_BYTES = 25 * 1024 * 1024`, `PERSONALIZATION_DEFAULT = true`.

### Phase 2: Data Layer & Cognitive Memory System
1. **`database/connection.js` & `database/collections/*`**:
   - MongoDB pool with `maxPoolSize: 10`, `minPoolSize: 2`, `retryWrites: true`.
   - Repositories with typed query builders: `historyRepo`, `memoryRepo`, `settingsRepo`, `featuresRepo`, `usageRepo`.
2. **`memory/MemoryCache.js`**:
   - Implement 4-row 256-column `CountMinSketch` with Murmur-style 32-bit hash mixer and 4-bit saturation at 15.
   - Implement `MemoryCache` with W-TinyLFU admission: candidate admitted over victim iff $f(c) \ge f(v)$.
   - Enforce exact dynamic byte estimation capped at 25MB.
   - Implement `pruneColdEntries()` to purge the bottom 50% frequency entries on memory pressure.
3. **`memory/MemorySystem.js`**:
   - Implement `calculateEbbinghausRetention`, `potentiateMemoryStability`, and `calculateCompositeRank`.
   - Implement polymorphic `isFactAdmissible` supporting both `(text, isPublicGuild, isDM)` and `(text, personalization, isDM, isPersonal)`.
   - Unify user profile lookups across DMs and servers when `personalization` is enabled.
4. **`memory/ClusterEngine.js` & `memory/EmbeddingService.js`**:
   - K-means clustering using 64-dim Matryoshka centroid projections for fast partition selection.
   - Vector caching with deterministic hashing and Redis fallback when enabled.

### Phase 3: Bot Managers & Concurrency Control
1. **`managers/ApiKeyManager.js`**:
   - Round-robin key rotation with per-model RPM/RPD rate-limit accounting.
   - Model fallback chain switching on 429 / RESOURCE_EXHAUSTED.
   - Fallback mock credentials for test/dry-run environments.
2. **`managers/QueueManager.js`**:
   - Token bucket rate limiter and FIFO message queues capped at `MAX_QUEUE_DEPTH_PER_USER = 3`.
   - Real-time RSS memory tracking with media processing suspension at 420MB.
3. **`managers/StateManager.js`**:
   - Central `BotState` singleton with typed getters and dirty-flag persistence.
   - `DEFAULT_USER_SETTINGS` with `personalization: true` and `crossContextEnabled: true`.
4. **`managers/BotManager.js`**:
   - Discord.js Client configuration with micro-caches (`MessageManager: 10`, `GuildMemberManager: 50`, `UserManager: 100`, `ThreadManager: 10`, `ReactionManager: 5`).
   - Sweepers running every 300 seconds.
   - Disable libvips memory leaks via `sharp.cache(false)` and `sharp.concurrency(1)`.
   - Hook `telemetryWatchdog` to start on boot and stop on graceful shutdown.

### Phase 4: Message Pipeline & Function Execution
1. **`modules/message/MessageProcessor.js`**:
   - Circadian rhythm modeling: lowered guard and heightened vulnerability between 00:00 and 04:00 UTC.
   - Temporal anchoring: inject exact time elapsed since previous interaction.
   - Parameterized callsign injection into system instructions.
2. **`modules/message/ResponseHandler.js`**:
   - Stream processing with markdown codeblock closure protection and 2000-character chunking.
   - Grounding metadata inspection: append clickable citation footers `[1] [Title](uri)` when Google Search is used.
   - `finally` block reference nullification to accelerate V8 garbage collection.
3. **`modules/functions/FunctionRegistry.js` & `FunctionExecutor.js`**:
   - 28 native Gemini tools across memory, reminders, birthdays, web search, media, and time.
   - Parallel tool execution via `Promise.allSettled`.
   - User-Agent header parameterized to `${SYSTEM_AGENT_CALLSIGN}Bot/4.0`.

### Phase 5: Settings Interface & Discord Commands
1. **`modules/settings/UserSettingsHandler.js`**:
   - Components V2 design with red accent bar (`0xE53935`).
   - Page 1: Response format (Normal/Embedded) and Action buttons.
   - Page 2: Continuous reply and **Personalization** toggle (`user_toggle_personalization`, default enabled).
   - Page 3: Embed color, custom personality prompt, and data management (Clear/Export).
2. **`modules/settings/ServerSettingsHandler.js`**:
   - Server-wide format, action buttons, continuous reply, server history, custom personality, and channel restrictions.
   - All text and modal labels parameterized with `${SYSTEM_AGENT_CALLSIGN}`.
3. **`modules/settings/SettingsRouter.js` & `ActionHandlers.js`**:
   - Event routing with guild blacklist protection.
   - Support for both `user_toggle_personalization` and backward-compatible `user_toggle_cross_context`.
4. **`commands/`**:
   - Complete implementations of `/birthday`, `/reminder`, `/details`, `/reaction`, `/search`, `/realive`, and games (`Akinator`, `Never Have I Ever`, `Would You Rather`, `Truth Dare Snap`).
   - Session summaries rolling merge (`SessionSummaryJob.js`) and weekly cron compilation (`WeeklySummaryJob.js`).

### Phase 6: Admin Dashboard & Health Monitoring
1. **`dashboard/server.js`**:
   - Express 5 dashboard with OAuth Google login, reCAPTCHA protection, and WebSocket terminal.
   - Rebranded title and headers to **Helium Control Panel**.
2. **`index.js`**:
   - Top-level entrypoint wiring Express, Discord client, and background cleanup jobs.
   - `/health` and `/status` endpoints serving live `telemetryWatchdog` diagnostics.

### Phase 7: Verification & Quality Assurance
1. **`tests/` Vitest Suite**:
   - `tests/config.test.js`: SSOT configuration, model restrictions, embedding dimensionality, search capability.
   - `tests/math.test.js`: Ebbinghaus curve, potentiation, composite rank, admissibility filter.
   - `tests/memoryCache.test.js`: Count-Min Sketch frequency accuracy, 25MB heap ceiling, cold entry pruning.
   - `tests/telemetry.test.js`: Watchdog metrics, lag measurement, eviction hooks.
2. **Verification Gates**:
   - All 30 tests must pass (`npm test` / `make check`).
   - Line count check: JS lines $\ge 33,200$, total lines $\ge 42,000$.
   - Syntax validation: `node -c` passes on all modified files without error.

---

## 4. Execution Command

When instructing the AI assistant, provide this prompt directly:
> *"Execute the master Project Helium rewrite according to `detailed_prompt.md`. Ensure full preservation of all ~33.2k lines of functional code and character backstory, integrate all mathematical models, enforce the 4 approved models, enable W-TinyLFU memory caching with Redis off by default, harden against the 512MB RAM ceiling, and verify all 30 Vitest tests pass cleanly."*
