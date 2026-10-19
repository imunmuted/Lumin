# Changelog

All notable changes to Project Helium are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

---

## [4.0.0-helium] - 2026-10-19

### Added
- **Unified Cognitive Memory System**:
  - Mathematical Ebbinghaus forgetting curve modeling retention probability:
    $$R(\Delta t) = \exp\left(-\frac{\Delta t}{S \cdot \mathcal{I}}\right)$$
  - Spaced retrieval potentiation calculation:
    $$S_{n+1} = S_n \cdot \left(1 + \alpha P e^{-\beta R}\right)$$
  - Multi-factor composite neural rank combining cosine similarity ($w_{\text{sim}} = 0.60$), temporal retention ($w_{\text{ret}} = 0.25$), and emotional salience ($w_{\text{sal}} = 0.15$).
  - Information privacy barrier (`isFactAdmissible`) preventing confidential tokens, passwords, and private DM facts from surfacing in public server channels.
- **High-Hit-Rate Native In-Memory Cache (W-TinyLFU)**:
  - 4-row 256-column `CountMinSketch` frequency filter for saturating 4-bit frequency tracking.
  - Windowed TinyLFU admission and eviction enforcing a strict 25MB heap ceiling (`FAST_MEMORY_CACHE_MAX_BYTES`).
  - Emergency cold-entry pruning (`pruneColdEntries()`) to evict bottom 50% frequency candidates under high memory pressure.
- **Render Free Tier Telemetry & Watchdog Daemon**:
  - Continuous monitoring of RSS, heap fragmentation ($\Phi = 1 - \frac{\text{heapUsed}}{\text{heapTotal}}$), and high-resolution event loop lag.
  - Automatic V8 garbage collection triggering (`global.gc()`) and emergency cache eviction hooks before reaching the 512MB RAM ceiling.
  - Real-time telemetry payload surfaced on `/status` and `/health` Express endpoints.
- **White-Label Parameterization**:
  - Callsign parameterization via `SYSTEM_AGENT_CALLSIGN = (process.env.SYSTEM_AGENT_CALLSIGN || 'Lumin').trim()`.
  - Rebranded UI embeds, settings dashboards, birthday setup, reminder forms, anniversary statistics, and admin panel to Helium.
- **Google Search Grounding & Citations**:
  - Standardized on `@google/genai` SDK with built-in `googleSearch: {}` tool.
  - Formatted clickable markdown citation footers (`[1] [Title](uri)`) appended to normal response text.
- **Comprehensive Vitest Test Suite**:
  - 4 test suites with 30 unit tests covering SSOT configuration, cognitive mathematical models, W-TinyLFU caching, and watchdog telemetry.
- **Production Tooling**:
  - `Makefile` targets: `check`, `test`, `dev`, `start`, `clean`.
  - GitHub Actions CI workflow (`.github/workflows/ci.yml`) and Dependabot config (`.github/dependabot.yml`).

### Changed
- **Model Restrictions**:
  - Pinned strictly to 2 Gemini models (`gemini-3.8-flash` / `gemini-3.8-flash-preview` and `gemini-3.5-flash-lite`) and 2 Gemma 4 models (`gemma-4-31b` / `gemma-4-31b-it` and `gemma-4-28b` / `gemma-4-26b-a4b-it`).
  - Gemma models configured strictly for custom `functionDeclarations`.
- **Standalone Default Configuration**:
  - Set `ENABLE_REDIS=false` by default, enabling zero-dependency deployment on Render Free Tier while matching Redis performance via `FastMemoryCache`.
- **User Settings Personalization Toggle**:
  - Renamed Page 2 Cross-Context Memory to unified **Personalization** (`user_toggle_personalization`, default: `true`) with backward-compatible fallback for `user_toggle_cross_context`.
- **Discord Client Micro-Caches**:
  - Pinned collection limits in `BotManager.js` (`MessageManager: 10`, `GuildMemberManager: 50`, `UserManager: 100`, `ThreadManager: 10`, `ReactionManager: 5`).
  - Reduced cache sweep interval from 3,600s to 300s.
- **Media Optimization**:
  - Disabled libvips buffer cache (`sharp.cache(false)`) and set single-thread concurrency (`sharp.concurrency(1)`) to eliminate memory leaks on 0.1 vCPU.
- **Code Volume**:
  - Expanded codebase to 33,189 JS lines (42,428 total lines) with zero feature loss and zero personality alteration.

### Fixed
- Fixed memory leaks caused by unbounded discord.js collections during high server chatter.
- Fixed 400 `INVALID_ARGUMENT` crashes during model fallback rotation by stripping Gemini 3-specific parameters (`includeServerSideToolInvocations`).
- Fixed dangling buffer references in streaming response pipelines by implementing explicit nullification in `finally` blocks.

### Security
- Added `isFactAdmissible` privacy gate to block cross-context exposure of credentials or sensitive data.
- Hardened OAuth token handling and session storage in the admin control panel.
- Validated environment variables at boot with graceful fallbacks.

---

## [3.0.0] - 2026-03-15

### Added
- Multi-key Gemini API rotation with automatic quota backoff and circuit breaking.
- Rolling session summaries collapsing conversation history over 24-hour windows.
- Components V2 interactive dashboard and paginated settings interface.
- 28 autonomous function-calling tools across memory, reminders, birthdays, and web search.

### Changed
- Migrated primary database driver to MongoDB v6 with pooled connections.
- Standardized embed styling across user and server notifications.

---

## [2.0.0] - 2025-11-20

### Added
- Semantic RAG retrieval pipeline with vector search and K-means clustering.
- Admin dashboard (`LuminDash`) with WebSocket terminal monitoring and runtime configuration.
- Multi-tier queue manager with per-user depth bounding and rate-limit tracking.

---

## [1.0.0] - 2025-06-01

### Added
- Initial release of Lumin Discord AI Companion.
- Basic conversation memory, personality customization, and conversational games.
