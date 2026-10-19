import { HarmBlockThreshold, HarmCategory } from '@google/genai';

// ── BOT ──────────────────────────────────────────────────────────────────────

export const BOT_CONFIG = Object.freeze({
  DEFAULT_RESPONSE_FORMAT: 'Normal',
  HEX_COLOUR:  '#5B7C99', // embed color fallback everywhere
  WORK_IN_DMS: true
});

// ── GEMMA / AI ROUTING ───────────────────────────────────────────────────────
// ENABLE_GEMMA = true routes all standard chat through Gemma globally.
// /search and /summary always use Gemini regardless — they need incompatible tools.

import { SYSTEM_AGENT_CALLSIGN } from '../config.js';
export { SYSTEM_AGENT_CALLSIGN };

export const ENABLE_GEMMA            = true;
export const GEMMA_DEFAULT_MODEL     = 'gemma-4-28b';  // key in MODELS map
export const GEMMA_FALLBACK_MODEL    = 'gemma-4-31b';  // key in MODELS map, used when CYCLE_GEMMA_WITH_GEMINI=true
export const CYCLE_GEMMA_WITH_GEMINI = false;          // true = append Gemma to fallback chain after all Gemini keys exhaust

// ── RAG ──────────────────────────────────────────────────────────────────────
// ENABLE_RAG = true  → auto vector-search memory before every reply once
//                       history exceeds MEMORY_RECENT_WINDOW messages.
// ENABLE_RAG = false → no automatic RAG; the AI uses the search_memory tool
//                       only when it decides it actually needs old context.
//                       Saves ~3 embed API calls per message.
export const ENABLE_RAG = false;

// ── MODELS ───────────────────────────────────────────────────────────────────

export const DEFAULT_MODEL = 'gemini-3.5-flash-lite';

export const MODELS = Object.freeze({
  // ── Gemini 3 series (strictly 2 models) ────────────────────────────────────
  'gemini-3.8-flash':      'gemini-3.8-flash-preview',      // flagship reasoning & search grounding
  'gemini-3.5-flash-lite': 'gemini-3.5-flash-lite',         // high-throughput, low latency, micro-cost

  // ── Gemma 4 series (strictly 2 models) ────────────────────────────────────
  'gemma-4-31b':           'gemma-4-31b-it',                // dense 31B instruction-tuned
  'gemma-4-28b':           'gemma-4-26b-a4b-it',            // 28B/26B MoE active params
  'gemma-4-26b':           'gemma-4-26b-a4b-it',            // alias for backwards compatibility
});

export const GEMINI_3_MODELS = Object.freeze([
  'gemini-3.8-flash-preview',
  'gemini-3.8-flash',
  'gemini-3.5-flash-lite',
]);

export const GEMMA_MODELS = Object.freeze([
  'gemma-4-31b-it',
  'gemma-4-31b',
  'gemma-4-26b-a4b-it',
  'gemma-4-28b-it',
  'gemma-4-28b',
  'gemma-4-26b',
]);

export const GEMMA_DAILY_LIMIT_PER_KEY     = 1500;
export const GEMMA_SUPPORTED_MIME_PREFIXES = ['image/'];
export const GEMMA_SUPPORTED_EXTENSIONS    = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.tiff'];

export function isGemmaModel(modelName) {
  if (!modelName) return false;
  return GEMMA_MODELS.includes(modelName) || /gemma/i.test(modelName);
}

// ── MODEL CAPABILITIES & GROUNDING RULES ──────────────────────────────────────
export const MODEL_CAPABILITIES = Object.freeze({
  'gemini-3.8-flash-preview': {
    supportsGoogleSearch: true,
    supportsFunctionDeclarations: true,
    multimodal: true,
    provider: 'gemini'
  },
  'gemini-3.5-flash-lite': {
    supportsGoogleSearch: true,
    supportsFunctionDeclarations: true,
    multimodal: true,
    provider: 'gemini'
  },
  'gemma-4-31b-it': {
    supportsGoogleSearch: false,
    supportsFunctionDeclarations: true,
    multimodal: true,
    provider: 'gemma'
  },
  'gemma-4-26b-a4b-it': {
    supportsGoogleSearch: false,
    supportsFunctionDeclarations: true,
    multimodal: true,
    provider: 'gemma'
  },
  'gemma-4-28b-it': {
    supportsGoogleSearch: false,
    supportsFunctionDeclarations: true,
    multimodal: true,
    provider: 'gemma'
  }
});

/**
 * Checks whether a model natively supports Google Search Grounding.
 * Gemini 3 models support server-side googleSearch tools; Gemma models strictly
 * require custom function declarations.
 *
 * @param {string} modelName
 * @returns {boolean}
 */
export function doesModelSupportGoogleSearch(modelName) {
  const resolved = MODELS[modelName] || modelName;
  const cap = MODEL_CAPABILITIES[resolved];
  if (cap) return cap.supportsGoogleSearch;
  return !isGemmaModel(modelName);
}

// ── MODEL FALLBACK & RATE LIMITS ─────────────────────────────────────────────

// Models tried in order when rate limits are hit.
export const MODEL_FALLBACK_CHAIN = [
  'gemini-3.5-flash-lite',
  'gemini-3.8-flash'
];

// After this many successful calls on a model, proactively rotate to the next.
export const MODEL_CALL_THRESHOLDS = Object.freeze({
  'gemini-3.5-flash-lite': 500,
  'gemini-3.8-flash':      200
});

export const RATE_LIMIT_ERRORS = Object.freeze([429, 'RESOURCE_EXHAUSTED', 'RATE_LIMIT_EXCEEDED', 'QUOTA_EXCEEDED']);

// ── GENERATION CONFIG ────────────────────────────────────────────────────────

const GENERATION_DEFAULTS = { TEMPERATURE: 1.0, TOP_P: 0.95 };

function isGemini3Model(m) { return GEMINI_3_MODELS.includes(m); }

// Gemma thinking is on/off only (no levels). Currently off — pass thinking=true to enable.
function getGemmaConfig(thinking = false) {
  return {
    temperature: GENERATION_DEFAULTS.TEMPERATURE,
    topP:        GENERATION_DEFAULTS.TOP_P,
    ...(thinking ? { thinkingConfig: { thinkingLevel: 'high' } } : {})
  };
}

// Thinking disabled for Gemini 3 — allows tool use (thinking + tools conflict in preview).
function getGemini3Config() {
  return {
    temperature: GENERATION_DEFAULTS.TEMPERATURE,
    topP:        GENERATION_DEFAULTS.TOP_P,
    // thinkingConfig: { thinkingLevel: 'low' } // uncomment to enable thinking (breaks tool use)
  };
}

// Thinking disabled for Gemini 2 — same reason as above.
function getGemini2Config() {
  return {
    temperature: GENERATION_DEFAULTS.TEMPERATURE,
    topP:        GENERATION_DEFAULTS.TOP_P,
    // thinkingConfig: { thinkingBudget: -1 } // uncomment to enable dynamic thinking (breaks tool use)
  };
}

export function getGenerationConfig(modelName) {
  if (isGemmaModel(modelName))   return getGemmaConfig();
  if (isGemini3Model(modelName)) return getGemini3Config();
  return getGemini2Config();
}

export const generationConfig = getGenerationConfig('gemini-3-flash-preview');

// ── SAFETY SETTINGS ──────────────────────────────────────────────────────────

export const safetySettings = [
  { category: HarmCategory.HARM_CATEGORY_HARASSMENT,        threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,       threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_CIVIC_INTEGRITY,   threshold: HarmBlockThreshold.BLOCK_NONE },
];

// ── QUEUE & MEDIA ────────────────────────────────────────────────────────────

export const RAM_MEDIA_SUSPEND_THRESHOLD_MB = 380;   // suspend all media above this RSS in MB
export const KEY_SWITCH_HOLD_MS             = 1500;  // ms to wait after rotating API key
export const MAX_QUEUE_DEPTH_PER_USER       = 5;     // messages beyond this are dropped with a warning
export const PDF_ENABLED_FOR_GEMINI         = false; // disabled to save RAM and quota
export const ENABLE_REDIS                   = process.env.ENABLE_REDIS === 'true';
export const CACHE_ENABLED                  = ENABLE_REDIS; // Redis L3 cache; off by default, W-TinyLFU L1/L2 memory cache handles load
export const FAST_MEMORY_CACHE_MAX_BYTES    = 25 * 1024 * 1024; // 25MB heap ceiling for W-TinyLFU in-memory cache
export const PERSONALIZATION_DEFAULT        = true; // single unified cognitive memory toggle
export const WEEKLY_SUMMARY_ENABLED         = true;  // set false to skip weekly context summary job entirely
export const CROSS_CONTEXT_ENABLED          = true; // global default; unified per-user across DMs and channels

// ── MEDIA PROCESSING ─────────────────────────────────────────────────────────
// Individual toggles — set false to reject that media type before it hits the AI.
// RAM_MEDIA_SUSPEND_THRESHOLD_MB is the global kill-switch; these are per-type.
export const ENABLE_IMAGE_PROCESSING = true;   // inline images (png/jpeg)
export const ENABLE_VIDEO_PROCESSING = false;  // video attachments (mp4/mov)
export const ENABLE_AUDIO_PROCESSING = false;  // audio attachments (mp3/wav)
export const ENABLE_FILE_PROCESSING  = false;  // generic file attachments
export const ENABLE_WEB_SEARCH       = true;   // Gemini grounding / web search tool
export const ENABLE_FUNCTION_CALLING = true;   // all tool / function-call use

// ── BOT STATE ────────────────────────────────────────────────────────────────

export const STATE_CONFIG = Object.freeze({
  MAX_MESSAGES:            50,
  CONTEXT_BREAK_THRESHOLD: 1_800_000  // 30 min gap inserts a context break into history
});

// ── RESOURCE INTERVALS ───────────────────────────────────────────────────────

export const RESOURCE_CONFIG = Object.freeze({
  STATE_SAVE_INTERVAL: 300_000,  // 5 min
  STATS_LOG_INTERVAL:  900_000   // 15 min
});

// ── MIGRATION ────────────────────────────────────────────────────────────────

export const MIGRATION_CONFIG = {
  ENABLE_MIGRATION: false, // set true once to run; auto-disables after completion
  BATCH_SIZE:       50,
  BATCH_DELAY_MS:   100
};

// ── POLL ─────────────────────────────────────────────────────────────────────

export const POLL_CONFIG = Object.freeze({
  maxPollsPerMinute:   3,
  maxResultsPerMinute: 5,
  autoRespondToPolls:  true,
  minVotesForAnalysis: 1
});

// ── DATABASE ─────────────────────────────────────────────────────────────────

export const DB_CONNECTION_CONFIG = Object.freeze({
  MAX_POOL_SIZE:               10,  // raised from 3 — allows parallel Track1+2+3 + background indexing
  MIN_POOL_SIZE:               2,   // keep 2 alive to avoid cold-start latency
  SERVER_SELECTION_TIMEOUT_MS: 5_000,
  SOCKET_TIMEOUT_MS:           30_000,
  MAX_IDLE_TIME_MS:            60_000,
  RETRY_WRITES:                true,
  W:                           'majority'
});

export const DB_RETRY_CONFIG = Object.freeze({
  MAX_ATTEMPTS:  3,
  BASE_DELAY_MS: 1_000,
  MAX_DELAY_MS:  5_000
});

export const DB_VECTOR_SEARCH_CONFIG = Object.freeze({
  INDEX_NAME:                'vector_index',
  PATH:                      'embedding',
  NUM_CANDIDATES_MULTIPLIER: 10,
  DEFAULT_LIMIT:             4,
  SCORE_THRESHOLD:           0.72
});

// ── MEMORY SYSTEM ────────────────────────────────────────────────────────────

export const MEMORY_RECENT_WINDOW   = 10;    // messages kept in live context, not indexed
export const MEMORY_MAX_RAG_RESULTS = 3;     // max vector hits injected per prompt
export const MEMORY_SCORE_THRESHOLD = 0.72;  // min similarity to include a RAG result
export const MEMORY_TIME_GAP_MS     = 30_000;  // gap that inserts a TIME ELAPSED marker (display only)
export const MEMORY_RAG_CUTOFF_MS   = 300_000; // 5 min — RAG dedup: exclude memories more recent than this
export const MEMORY_MAX_INLINE_CTX  = 6_000; // raised from 1500 — truncate gracefully instead of dropping

// ── MEMORY CACHE ─────────────────────────────────────────────────────────────

export const MEMORY_CACHE_TTL_MS        = 2 * 60 * 1000;
export const MEMORY_CACHE_MAX_SIZE      = 200;
export const MEMORY_CACHE_MIN_QUERY_LEN = 10;
export const MEMORY_CACHE_SEMANTIC_SIM  = 0.92; // min cosine similarity for a cache hit

// ── MEMORY STORE ─────────────────────────────────────────────────────────────

export const MEMORY_CHUNK_SIZE            = 8;
export const MEMORY_CHUNK_OVERLAP         = 2;
export const MEMORY_INDEX_BATCH_SIZE      = 3;  // parallel embedding calls per indexing cycle
export const MEMORY_PERSONAL_CACHE_TTL_MS = 5 * 60 * 1000;

// ── CLUSTER ENGINE ───────────────────────────────────────────────────────────
// RAM budget: 300 embeddings × 12 KB × 15 users ≈ 54 MB. Don't raise CLUSTER_SAMPLE without checking RAM.

export const CLUSTER_MAX                  = 20;
export const CLUSTER_NUM_BASELINE         = 5;
export const CLUSTER_MIN_MEMORIES         = 30;   // was 150 — clustering now activates much earlier
export const CLUSTER_TOP_TO_SEARCH        = 2;
export const CLUSTER_MIN_SIMILARITY       = 0.45;
export const CLUSTER_REINDEX_INTERVAL     = 150;
export const CLUSTER_MAX_KMEANS_ITERS     = 10;
export const CLUSTER_CONVERGENCE_THRESHOLD = 0.001;
export const CLUSTER_CACHE_TTL_MS         = 15 * 60 * 1000;
export const CLUSTER_MAX_PER_CLUSTER      = 8;
export const CLUSTER_EMBEDDINGS_TTL_MS    = 2 * 60 * 1000;

export const CLUSTER_EMBEDDING_LIMITS = Object.freeze({
  CLUSTER_SAMPLE:       300,
  CLUSTER_TIME_BUCKETS: 6,
  FALLBACK_SEARCH:      30  // used when $vectorSearch index is unavailable
});

// ── EMBEDDING SERVICE ────────────────────────────────────────────────────────

export const EMBEDDING_MODEL            = 'gemini-embedding-2';
export const EMBEDDING_CACHE_MAX_SIZE   = 50;
export const EMBEDDING_MAX_CONCURRENT   = 3;
export const EMBEDDING_DIM              = 768;
export const EMBEDDING_MRL_SHORT_DIM    = 256;  // truncated dim for fast centroid search
export const EMBEDDING_MRL_CENTROID_DIM = 64;   // truncated dim for K-means first pass
export const EMBEDDING_REDIS_TTL        = 24 * 60 * 60; // 24h; embeddings are deterministic
export const EMBEDDING_REDIS_PREFIX     = 'helium:emb:';

// PDF/video/audio embedding disabled — not needed and saves quota
export const EMBEDDING_ENABLE_PDF   = false;
export const EMBEDDING_ENABLE_VIDEO = false;
export const EMBEDDING_ENABLE_AUDIO = false;

export const EMBEDDING_IMAGE_LIMIT = Object.freeze({
  MAX_COUNT:  6,
  MIME_TYPES: new Set(['image/png', 'image/jpeg'])
});

export const EMBEDDING_PDF_LIMIT = Object.freeze({
  MAX_COUNT: 1, MAX_PAGES: 6, MIME_TYPE: 'application/pdf'
});

export const EMBEDDING_VIDEO_LIMIT = Object.freeze({
  MAX_COUNT: 1, MAX_SECONDS: 120, WITH_AUDIO_MAX_SECONDS: 80,
  MIME_TYPES: new Set(['video/mp4', 'video/quicktime'])
});

export const EMBEDDING_AUDIO_LIMIT = Object.freeze({
  MAX_COUNT: 1, MAX_SECONDS: 80,
  MIME_TYPES: new Set(['audio/mpeg', 'audio/wav', 'audio/x-wav'])
});

// ── UTILS ────────────────────────────────────────────────────────────────────

export const UPLOAD_CONFIG = Object.freeze({
  SITE_URL:    'https://bin.mudfish.net',
  ENDPOINT:    '/api/text',
  TTL_MINUTES: 10080,
  TIMEOUT_MS:  3000
});

export const MESSAGE_FETCH_CONFIG = Object.freeze({
  MAX_ADDITIONAL: 99,
  DEFAULT_COUNT:  1
});

// ── DEFAULT EXPORT ───────────────────────────────────────────────────────────

export default {
  BOT_CONFIG,
  SYSTEM_AGENT_CALLSIGN,
  ENABLE_GEMMA, GEMMA_DEFAULT_MODEL, GEMMA_FALLBACK_MODEL, CYCLE_GEMMA_WITH_GEMINI,
  ENABLE_RAG,
  DEFAULT_MODEL, MODELS, GEMINI_3_MODELS, GEMMA_MODELS,
  GEMMA_DAILY_LIMIT_PER_KEY, GEMMA_SUPPORTED_MIME_PREFIXES, GEMMA_SUPPORTED_EXTENSIONS,
  isGemmaModel,
  MODEL_CAPABILITIES, doesModelSupportGoogleSearch,
  MODEL_FALLBACK_CHAIN, MODEL_CALL_THRESHOLDS, RATE_LIMIT_ERRORS,
  getGenerationConfig, generationConfig,
  safetySettings,
  RAM_MEDIA_SUSPEND_THRESHOLD_MB, KEY_SWITCH_HOLD_MS, MAX_QUEUE_DEPTH_PER_USER,
  PDF_ENABLED_FOR_GEMINI, ENABLE_REDIS, CACHE_ENABLED, FAST_MEMORY_CACHE_MAX_BYTES,
  PERSONALIZATION_DEFAULT, WEEKLY_SUMMARY_ENABLED, CROSS_CONTEXT_ENABLED,
  ENABLE_IMAGE_PROCESSING, ENABLE_VIDEO_PROCESSING, ENABLE_AUDIO_PROCESSING,
  ENABLE_FILE_PROCESSING, ENABLE_WEB_SEARCH, ENABLE_FUNCTION_CALLING,
  STATE_CONFIG, RESOURCE_CONFIG, MIGRATION_CONFIG, POLL_CONFIG,
  DB_CONNECTION_CONFIG, DB_RETRY_CONFIG, DB_VECTOR_SEARCH_CONFIG,
  MEMORY_RECENT_WINDOW, MEMORY_MAX_RAG_RESULTS, MEMORY_SCORE_THRESHOLD,
  MEMORY_TIME_GAP_MS, MEMORY_RAG_CUTOFF_MS, MEMORY_MAX_INLINE_CTX,
  MEMORY_CACHE_TTL_MS, MEMORY_CACHE_MAX_SIZE, MEMORY_CACHE_MIN_QUERY_LEN, MEMORY_CACHE_SEMANTIC_SIM,
  MEMORY_CHUNK_SIZE, MEMORY_CHUNK_OVERLAP, MEMORY_INDEX_BATCH_SIZE, MEMORY_PERSONAL_CACHE_TTL_MS,
  CLUSTER_MAX, CLUSTER_NUM_BASELINE, CLUSTER_MIN_MEMORIES, CLUSTER_TOP_TO_SEARCH,
  CLUSTER_MIN_SIMILARITY, CLUSTER_REINDEX_INTERVAL, CLUSTER_MAX_KMEANS_ITERS,
  CLUSTER_CONVERGENCE_THRESHOLD, CLUSTER_CACHE_TTL_MS, CLUSTER_MAX_PER_CLUSTER,
  CLUSTER_EMBEDDINGS_TTL_MS, CLUSTER_EMBEDDING_LIMITS,
  EMBEDDING_MODEL, EMBEDDING_CACHE_MAX_SIZE, EMBEDDING_MAX_CONCURRENT,
  EMBEDDING_DIM, EMBEDDING_MRL_SHORT_DIM, EMBEDDING_MRL_CENTROID_DIM,
  EMBEDDING_REDIS_TTL, EMBEDDING_REDIS_PREFIX,
  EMBEDDING_ENABLE_PDF, EMBEDDING_ENABLE_VIDEO, EMBEDDING_ENABLE_AUDIO,
  EMBEDDING_IMAGE_LIMIT, EMBEDDING_PDF_LIMIT, EMBEDDING_VIDEO_LIMIT, EMBEDDING_AUDIO_LIMIT,
  UPLOAD_CONFIG, MESSAGE_FETCH_CONFIG
};
