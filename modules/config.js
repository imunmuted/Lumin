import { HarmBlockThreshold, HarmCategory } from '@google/genai';

// ── BOT ──────────────────────────────────────────────────────────────────────

export const BOT_CONFIG = Object.freeze({
  DEFAULT_RESPONSE_FORMAT: 'Normal',
  HEX_COLOUR:  '#5B7C99', // embed color fallback everywhere
  WORK_IN_DMS: true,
  NAME: (process.env.BOT_NAME || 'Lumin').trim().slice(0, 64) || 'Lumin'
});

// ── MODEL REGISTRY ───────────────────────────────────────────────────────────
// This is the only model allowlist used by chat routing and the console API.
// IDs were checked against Google's current Gemini API model catalogue.

export const ENABLE_GEMMA = false;
export const GEMMA_DEFAULT_MODEL = 'gemma-4-26b';
export const GEMMA_FALLBACK_MODEL = 'gemma-4-31b';
export const CYCLE_GEMMA_WITH_GEMINI = true;

export const DEFAULT_MODEL = 'gemini-3.5-flash-lite';

export const MODEL_REGISTRY = Object.freeze({
  'gemini-4-argon': Object.freeze({
    id: 'gemini-4-argon', label: 'Gemini 4 Argon', family: 'gemini-4',
    supportsTools: true, supportsBuiltInTools: true, supportsSafetySettings: true, supportsAttachments: true,
  }),
  'gemini-3.8-flash': Object.freeze({
    id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', family: 'gemini-3',
    supportsTools: true, supportsBuiltInTools: true, supportsSafetySettings: true, supportsAttachments: true,
  }),
  'gemini-3.5-flash-lite': Object.freeze({
    id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite', family: 'gemini-3',
    supportsTools: true, supportsBuiltInTools: true, supportsSafetySettings: true, supportsAttachments: true,
  }),
  'gemma-4-26b': Object.freeze({
    id: 'gemma-4-26b-a4b-it', label: 'Gemma 4 26B A4B IT', family: 'gemma-4',
    supportsTools: true, supportsBuiltInTools: false, supportsSafetySettings: false, supportsAttachments: true,
  }),
  'gemma-4-31b': Object.freeze({
    id: 'gemma-4-31b-it', label: 'Gemma 4 31B IT', family: 'gemma-4',
    supportsTools: true, supportsBuiltInTools: false, supportsSafetySettings: false, supportsAttachments: true,
  }),
});

export const MODELS = Object.freeze(Object.fromEntries(
  Object.entries(MODEL_REGISTRY).map(([key, metadata]) => [key, metadata.id])
));
export const SUPPORTED_MODEL_IDS = Object.freeze(Object.values(MODELS));
export const GEMINI_3_MODELS = Object.freeze(['gemini-3.8-flash', 'gemini-3.5-flash-lite']);
export const GEMMA_MODELS = Object.freeze(['gemma-4-26b-a4b-it', 'gemma-4-31b-it']);

export function getModelMetadata(modelName) {
  const entry = Object.entries(MODEL_REGISTRY).find(([key, metadata]) => key === modelName || metadata.id === modelName);
  return entry ? entry[1] : null;
}

export function resolveModelId(modelName) {
  if (typeof modelName !== 'string') return MODELS[DEFAULT_MODEL];
  return MODELS[modelName] || (SUPPORTED_MODEL_IDS.includes(modelName) ? modelName : MODELS[DEFAULT_MODEL]);
}

export function isGemmaModel(modelName) {
  return getModelMetadata(modelName)?.family?.startsWith('gemma') === true || /gemma/i.test(modelName || '');
}

export const GEMMA_DAILY_LIMIT_PER_KEY = 1500;
export const GEMMA_SUPPORTED_MIME_PREFIXES = ['image/'];
export const GEMMA_SUPPORTED_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.tiff'];

// ── MODEL FALLBACK & RATE LIMITS ─────────────────────────────────────────────

// Models tried in order when rate limits are hit.
export const MODEL_FALLBACK_CHAIN = [
  'gemini-3.5-flash-lite',
  'gemini-3.8-flash',
  'gemini-4-argon'
];

// After this many successful calls on a model, proactively rotate to the next.
export const MODEL_CALL_THRESHOLDS = {
  'gemini-3.5-flash-lite': 500
};

export const RATE_LIMIT_ERRORS = [429, 'RESOURCE_EXHAUSTED', 'RATE_LIMIT_EXCEEDED', 'QUOTA_EXCEEDED'];

// ── GENERATION CONFIG ────────────────────────────────────────────────────────

const GENERATION_DEFAULTS = Object.freeze({ TEMPERATURE: 0.8, TOP_P: 0.95 });

export function getGenerationConfig(modelName) {
  const metadata = getModelMetadata(modelName);
  return {
    temperature: GENERATION_DEFAULTS.TEMPERATURE,
    topP: GENERATION_DEFAULTS.TOP_P,
    // Keep provider-specific experimental fields out of the shared config until
    // a model capability adapter explicitly verifies support.
  };
}

export const generationConfig = getGenerationConfig(DEFAULT_MODEL);

const SAFETY_CATEGORY_MAP = Object.freeze({
  harassment: HarmCategory.HARM_CATEGORY_HARASSMENT,
  hateSpeech: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
  sexualContent: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
  dangerousContent: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
  civicIntegrity: HarmCategory.HARM_CATEGORY_CIVIC_INTEGRITY,
  jailbreak: HarmCategory.HARM_CATEGORY_JAILBREAK,
});

// BALANCED is the default safety posture. Include only categories actually
// exposed by the installed SDK/provider, and never silently configure a
// category that a selected model does not support.
const DEFAULT_SAFETY_VALUES = Object.freeze({
  harassment: 'BLOCK_MEDIUM_AND_ABOVE',
  hateSpeech: 'BLOCK_MEDIUM_AND_ABOVE',
  sexualContent: 'BLOCK_MEDIUM_AND_ABOVE',
  dangerousContent: 'BLOCK_MEDIUM_AND_ABOVE',
  civicIntegrity: 'BLOCK_MEDIUM_AND_ABOVE',
  jailbreak: 'BLOCK_MEDIUM_AND_ABOVE',
});
export const DEFAULT_SAFETY_THRESHOLDS = Object.freeze(Object.fromEntries(
  Object.entries(DEFAULT_SAFETY_VALUES).filter(([category]) => SAFETY_CATEGORY_MAP[category] != null)
));
let runtimeSafetyThresholds = { ...DEFAULT_SAFETY_THRESHOLDS };
const VALID_THRESHOLDS = new Set(['BLOCK_NONE', 'BLOCK_ONLY_HIGH', 'BLOCK_MEDIUM_AND_ABOVE', 'BLOCK_LOW_AND_ABOVE', 'OFF']);

export function setSafetyThresholdOverrides(overrides = {}) {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) throw new TypeError('Safety thresholds must be an object');
  // Treat each call as a complete replacement over safe defaults. This makes
  // omitted categories reset predictably instead of retaining stale overrides.
  const next = { ...DEFAULT_SAFETY_THRESHOLDS };
  for (const [category, threshold] of Object.entries(overrides)) {
    if (!(category in SAFETY_CATEGORY_MAP) || SAFETY_CATEGORY_MAP[category] == null) throw new TypeError(`Unsupported safety category: ${category}`);
    if (threshold === null || threshold === '') { next[category] = DEFAULT_SAFETY_THRESHOLDS[category]; continue; }
    if (!VALID_THRESHOLDS.has(threshold)) throw new TypeError(`Unsupported threshold for ${category}`);
    if (HarmBlockThreshold[threshold] === undefined) throw new TypeError(`Threshold ${threshold} is unsupported by the installed Google GenAI SDK.`);
    next[category] = threshold;
  }
  runtimeSafetyThresholds = next;
  return getSafetyThresholds();
}

export function getSafetyThresholds() {
  return { ...runtimeSafetyThresholds };
}

export function getSafetySettings(modelName = DEFAULT_MODEL) {
  const metadata = getModelMetadata(modelName);
  if (metadata && !metadata.supportsSafetySettings) return [];
  return Object.entries(SAFETY_CATEGORY_MAP).filter(([, category]) => category != null).map(([key, category]) => ({
    category,
    threshold: (() => {
      const resolved = HarmBlockThreshold[runtimeSafetyThresholds[key]];
      if (resolved === undefined) throw new TypeError(`Safety threshold ${runtimeSafetyThresholds[key]} is unsupported by the installed Google GenAI SDK.`);
      return resolved;
    })(),
  }));
}

export const safetySettings = getSafetySettings(DEFAULT_MODEL);

// ── QUEUE & MEDIA ────────────────────────────────────────────────────────────

export const RAM_MEDIA_SUSPEND_THRESHOLD_MB = 380;   // suspend all media above this RSS in MB
export const KEY_SWITCH_HOLD_MS             = 1500;  // ms to wait after rotating API key
export const MAX_QUEUE_DEPTH_PER_USER       = 5;     // messages beyond this are dropped with a warning
export const PDF_ENABLED_FOR_GEMINI         = false; // disabled to save RAM and quota
export const CACHE_ENABLED                  = false; // Heavy application-level caches are disabled by default
export const WEEKLY_SUMMARY_ENABLED         = false; // automatic weekly memory summaries are disabled; explicit summary features remain available
export const CROSS_CONTEXT_ENABLED          = false; // global default; overridden per-user via userSettings

// ── MEDIA PROCESSING ─────────────────────────────────────────────────────────
// Individual toggles — set false to reject that media type before it hits the AI.
// RAM_MEDIA_SUSPEND_THRESHOLD_MB is the global kill-switch; these are per-type.
export const ENABLE_IMAGE_PROCESSING = true;    // available only after explicit per-user attachment grant
export const ENABLE_VIDEO_PROCESSING = true;   // available only after explicit per-user attachment grant
export const ENABLE_AUDIO_PROCESSING = true;   // available only after explicit per-user attachment grant
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
  ENABLE_GEMMA, GEMMA_DEFAULT_MODEL, GEMMA_FALLBACK_MODEL, CYCLE_GEMMA_WITH_GEMINI,
  DEFAULT_MODEL, MODELS, MODEL_REGISTRY, SUPPORTED_MODEL_IDS, GEMINI_3_MODELS, GEMMA_MODELS,
  GEMMA_DAILY_LIMIT_PER_KEY, GEMMA_SUPPORTED_MIME_PREFIXES, GEMMA_SUPPORTED_EXTENSIONS,
  isGemmaModel, getModelMetadata, resolveModelId,
  MODEL_FALLBACK_CHAIN, MODEL_CALL_THRESHOLDS, RATE_LIMIT_ERRORS,
  getGenerationConfig, generationConfig,
  safetySettings, getSafetySettings, getSafetyThresholds, setSafetyThresholdOverrides,
  RAM_MEDIA_SUSPEND_THRESHOLD_MB, KEY_SWITCH_HOLD_MS, MAX_QUEUE_DEPTH_PER_USER,
  PDF_ENABLED_FOR_GEMINI, CACHE_ENABLED, WEEKLY_SUMMARY_ENABLED,
  ENABLE_IMAGE_PROCESSING, ENABLE_VIDEO_PROCESSING, ENABLE_AUDIO_PROCESSING,
  ENABLE_FILE_PROCESSING, ENABLE_WEB_SEARCH, ENABLE_FUNCTION_CALLING,
  STATE_CONFIG, RESOURCE_CONFIG, MIGRATION_CONFIG, POLL_CONFIG,
  DB_CONNECTION_CONFIG, DB_RETRY_CONFIG,
  UPLOAD_CONFIG, MESSAGE_FETCH_CONFIG
};
