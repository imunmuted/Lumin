# Project Helium — Engineering Guidelines & AI Pair Programmer Contract

## Architecture & Principles
- **Project Codename**: Helium (`helium`)
- **Agent Callsign**: Defaults to `'Lumin'`, strictly sourced from `SYSTEM_AGENT_CALLSIGN`. Never hardcode `'Lumin'` or `'helium'` into business logic, queries, or prompt templates.
- **Strict Layering**: Ingress (`interface/`) -> Domain (`services/`) -> Persistence (`database/`) -> Utilities (`helpers/`) -> Infrastructure (`core/`) -> SSOT (`config/`, `constants/`).
- **Dependencies Direction**: Strictly downward. Services NEVER import `discord.js`. Interfaces handle Discord interactions and call domain services with plain JavaScript primitives.
- **Resource Budget (Render Free Tier)**: Hard ceiling of 512MB RAM. Maximum baseline RSS < 140MB. All buffers must be flushed, caches must obey byte ceilings, and Discord sweepers must actively purge stale messages.

## Cognitive Neural Memory Rules
- All user memory is consolidated into **ONE single unified neural profile** (`UnifiedNeuralProfileRepository`) identified by the user's Discord snowflake.
- **Single Master Setting**: `personalization` (`true` or `false`).
- **Mathematical Privacy Boundaries**: `isFactAdmissible` enforces zero-leak privacy. Confidential DM disclosures NEVER surface in public server channels. Shareable preferences (food, colors, games, birthday) bridge universally.
- **Synaptic Pruning**: Messages older than 3 days in the hippocampal buffer (`chatHistories`) are summarized into neocortical episodic records and permanently purged from raw storage.

## Model Standards
- **Gemini Generation Models**: Exclusively `gemini-3.8-flash` and `gemini-3.5-flash-lite`.
- **Gemma Open Models**: Exclusively `gemma-4-31b` (`gemma-4-31b-it`) and `gemma-4-28b` (`gemma-4-26b-a4b-it`).
- **Multimodal Embedding**: `gemini-embedding-2` with `outputDimensionality: 768`. Coarse search slices first 64 dimensions for sub-0.10ms lookups.

## Developer Commands
- Run test suite: `npm run test`
- Start local process: `npm run dev`
- Run linter: `npm run lint`
- Full check: `npm run check`
