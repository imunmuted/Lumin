/**
 * @fileoverview API Key Manager — Google Gemini key loading, per-model rate limiting,
 * intelligent key/model rotation, and the `withRetryPerModel` execution engine.
 *
 * Responsibilities (and ONLY these):
 *  - Load & validate keys from environment
 *  - Track per-key, per-model rate limit windows & cooldowns
 *  - Find the next available model or key on exhaustion
 *  - Execute any Gemini API call with full retry/rotation logic
 *  - Expose read-only statistics for monitoring
 *
 * @module managers/ApiKeyManager
 */

import { GoogleGenAI } from '@google/genai';
import {
  MODEL_FALLBACK_CHAIN, MODEL_CALL_THRESHOLDS, DEFAULT_MODEL,
  isGemmaModel, GEMMA_DAILY_LIMIT_PER_KEY,
  CYCLE_GEMMA_WITH_GEMINI, GEMMA_DEFAULT_MODEL, GEMMA_FALLBACK_MODEL, MODELS,
  KEY_SWITCH_HOLD_MS, ENABLE_GEMMA
} from '../modules/config.js';
import { Logger } from '../core/Logger.js';

const logger = Logger.get('ApiKeyManager');

// Strip any 39+ char alphanumeric sequences from error messages — these are the
// shape of Google API keys. Prevents accidental key exposure in log sinks.
function sanitizeErrorMessage(msg) {
  if (typeof msg !== 'string') return String(msg);
  return msg.replace(/[A-Za-z0-9_-]{39,}/g, '[REDACTED]');
}

// ============================================================================
// CONFIGURATION
// ============================================================================

/**
 * Rate limiting configuration.
 * @readonly
 */
const RATE_LIMIT_CONFIG = Object.freeze({
  /** Default RPM per model per key (used by 2.5 variants). */
  REQUESTS_PER_MINUTE: 15,

  /**
   * Per-model RPM overrides.
   * `Infinity` = no proactive RPM switching; only reacts to real 429s or
   * MODEL_CALL_THRESHOLDS.
   * @type {Record<string, number>}
   */
  MODEL_REQUESTS_PER_MINUTE: {
    'gemini-3.5-flash-lite': Infinity,
    'gemini-3.8-flash':      Infinity,
    'gemma-4-31b':           Infinity,
    'gemma-4-28b':           Infinity
  },

  /** Sliding-window duration in ms. */
  WINDOW_DURATION_MS: 60_000,

  /** How long a model/key stays in cooldown after hitting a rate limit (ms). */
  COOLDOWN_DURATION_MS: 60_000,

  /** Per-error-type retry delay in ms. */
  RETRY_DELAYS: Object.freeze({
    FORBIDDEN:    3_000,
    RATE_LIMIT:   2_500,
    SERVER_ERROR: 1_000,
    DEFAULT:      1_000
  })
});

/**
 * Retry strategy configuration.
 * MAX_TOTAL_ATTEMPTS is updated at runtime once keys are loaded.
 */
const RETRY_STRATEGY = {
  /** Max attempts per key before forcing rotation. */
  MAX_ATTEMPTS_PER_KEY: 3,

  /** Max total attempts across ALL keys — updated after keys load. */
  MAX_TOTAL_ATTEMPTS: 3
};

// ============================================================================
// KEY LOADING & VALIDATION
// ============================================================================

/**
 * Validate that an API key is a non-empty, space-free string of minimum length.
 * @param {string} key
 * @returns {boolean}
 */
function validateApiKey(key) {
  return typeof key === 'string' && key.length > 20 && !key.includes(' ');
}

/**
 * Load and validate API keys from environment variables.
 * Supports indexed keys (`GOOGLE_API_KEY1`, `GOOGLE_API_KEY2`, …) and a
 * single fallback `GOOGLE_API_KEY`.
 *
 * @returns {string[]} Non-empty array of validated keys.
 * @throws {Error} If no valid keys are found.
 */
function loadApiKeys() {
  const keys = [];
  let idx = 1;

  while (process.env[`GOOGLE_API_KEY${idx}`]) {
    const key = process.env[`GOOGLE_API_KEY${idx}`];
    if (validateApiKey(key)) {
      keys.push(key);
    } else {
      logger.warn(`Invalid key format at GOOGLE_API_KEY${idx} — skipping`);
    }
    idx++;
  }

  if (keys.length === 0 && process.env.GOOGLE_API_KEY) {
    const key = process.env.GOOGLE_API_KEY;
    if (validateApiKey(key)) {
      keys.push(key);
    } else {
      logger.warn('Invalid key format at GOOGLE_API_KEY — skipping');
    }
  }

  if (keys.length === 0) {
    if (process.env.NODE_ENV === 'test' || !process.env.DISCORD_BOT_TOKEN) {
      logger.warn('No Gemini API keys provided in environment — using dry-run placeholder key for tests');
      return ['AIzaSyDummyTestKeyForUnitTestingPurposesOnly000'];
    }
    throw new Error('No valid Gemini API keys found in environment variables');
  }

  return keys;
}

// ============================================================================
// STATE — all mutable rate-limit tracking lives here, private to this module
// ============================================================================

const apiKeys       = loadApiKeys();
RETRY_STRATEGY.MAX_TOTAL_ATTEMPTS = Math.max(3, apiKeys.length * 3);

logger.info(
  `Loaded ${apiKeys.length} API key(s) | ` +
  `Retry strategy: ${RETRY_STRATEGY.MAX_TOTAL_ATTEMPTS} total attempts ` +
  `(${apiKeys.length} keys × 3)`
);

/** Currently active key index. */
let currentKeyIdx = 0;

/** Currently active GoogleGenAI client. */
let currentClient = new GoogleGenAI({ apiKey: apiKeys[currentKeyIdx] });

/**
 * Per-key usage counters.
 * @type {Map<number, {requests:number, lastUsed:number|null, errors:number, successfulRequests:number}>}
 */
const keyUsageStats = new Map();

/**
 * Per-key last-error tracking.
 * @type {Map<number, {lastError:{message:string, timestamp:string}|null}>}
 */
const keyErrorTracking = new Map();

/**
 * Key-level cooldown timestamps (epoch ms — ignore key until this time).
 * @type {Map<number, number>}
 */
const keyCooldowns = new Map();

/**
 * Global successful-call counter per model (across all keys).
 * Used to proactively rotate away from a model once MODEL_CALL_THRESHOLDS is hit.
 * Resets when the model rotates back in.
 * @type {Map<string, number>}
 */
const modelGlobalCallCounts = new Map();
(MODEL_FALLBACK_CHAIN || []).forEach(m => modelGlobalCallCounts.set(m, 0));

// ── Model chain setup ─────────────────────────────────────────────────────────
// ENABLE_GEMMA=true  → Gemma-only; Gemini is never used.
// CYCLE_GEMMA_WITH_GEMINI=true → Gemini first, Gemma appended as fallback.
// Neither flag → Gemini-only (default chain from config).

if (ENABLE_GEMMA) {
  // Replace the chain entirely — only Gemma models allowed.
  MODEL_FALLBACK_CHAIN.length = 0;
  const gemmaModels = [
    MODELS[GEMMA_DEFAULT_MODEL],
    MODELS[GEMMA_FALLBACK_MODEL]
  ].filter(Boolean);
  MODEL_FALLBACK_CHAIN.push(...gemmaModels);
  gemmaModels.forEach(m => modelGlobalCallCounts.set(m, 0));
  logger.info(`ENABLE_GEMMA=true — Gemma-only chain: ${MODEL_FALLBACK_CHAIN.join(' → ')}`);

} else if (CYCLE_GEMMA_WITH_GEMINI) {
  // Gemini chain stays first; Gemma appended as last-resort fallback.
  const gemmaModels = [
    MODELS[GEMMA_DEFAULT_MODEL],
    MODELS[GEMMA_FALLBACK_MODEL]
  ].filter(m => m && !MODEL_FALLBACK_CHAIN.includes(m));
  MODEL_FALLBACK_CHAIN.push(...gemmaModels);
  gemmaModels.forEach(m => modelGlobalCallCounts.set(m, 0));
  logger.info(`CYCLE_GEMMA_WITH_GEMINI=true — chain: ${MODEL_FALLBACK_CHAIN.join(' → ')}`);
}

/**
 * Per-model per-key rate-limit window tracking.
 * Structure: `Map<keyIdx, Map<modelName, {count:number, windowStart:number}>>`
 * @type {Map<number, Map<string, {count:number, windowStart:number}>>}
 */
const keyModelRateLimits = new Map();

/**
 * Per-model per-key cooldown tracking.
 * Structure: `Map<keyIdx, Map<modelName, number>>` (epoch ms)
 * @type {Map<number, Map<string, number>>}
 */
const keyModelCooldowns = new Map();

// Initialise tracking structures for every key.
apiKeys.forEach((_, i) => {
  keyUsageStats.set(i,    { requests: 0, lastUsed: null, errors: 0, successfulRequests: 0 });
  keyErrorTracking.set(i, { lastError: null });
  keyModelRateLimits.set(i, new Map());
  keyModelCooldowns.set(i, new Map());
});

/**
 * Per-key daily call counts for Gemma models.
 * Resets at UTC midnight via resetGemmaKeyDailyCounts().
 * @type {Map<number, number>}
 */
const gemmaKeyDailyCounts = new Map();
apiKeys.forEach((_, i) => gemmaKeyDailyCounts.set(i, 0));

/**
 * Reset all per-key Gemma daily counters. Called by StateManager's daily reset.
 */
export function resetGemmaKeyDailyCounts() {
  apiKeys.forEach((_, i) => gemmaKeyDailyCounts.set(i, 0));
  logger.info('Gemma daily key counters reset');
}

/**
 * Check if a key has hit the Gemma daily limit.
 * @param {number} keyIdx
 * @returns {boolean}
 */
function isGemmaKeyExhausted(keyIdx) {
  return (gemmaKeyDailyCounts.get(keyIdx) || 0) >= GEMMA_DAILY_LIMIT_PER_KEY;
}

/**
 * Increment the daily counter for a Gemma request on the given key.
 * @param {number} keyIdx
 */
function incrementGemmaDailyCount(keyIdx) {
  gemmaKeyDailyCounts.set(keyIdx, (gemmaKeyDailyCounts.get(keyIdx) || 0) + 1);
}

// ============================================================================
// RATE-LIMIT HELPERS
// ============================================================================

/**
 * Check whether a specific model on a specific key has exceeded its RPM limit.
 * Automatically resets the window if more than WINDOW_DURATION_MS has elapsed.
 *
 * @param {number} keyIdx
 * @param {string} modelName
 * @returns {boolean}
 */
function isModelRateLimited(keyIdx, modelName) {
  const modelLimits = keyModelRateLimits.get(keyIdx);
  if (!modelLimits) return false;

  const data = modelLimits.get(modelName);
  if (!data) return false;

  const now = Date.now();
  if (now - data.windowStart >= RATE_LIMIT_CONFIG.WINDOW_DURATION_MS) {
    data.count = 0;
    data.windowStart = now;
    modelLimits.set(modelName, data);
    return false;
  }

  const rpmLimit =
    RATE_LIMIT_CONFIG.MODEL_REQUESTS_PER_MINUTE?.[modelName] ??
    RATE_LIMIT_CONFIG.REQUESTS_PER_MINUTE;

  return data.count >= rpmLimit;
}

/**
 * Increment the RPM counter for a model on a key.
 * @param {number} keyIdx
 * @param {string} modelName
 */
function incrementModelRateLimit(keyIdx, modelName) {
  const modelLimits = keyModelRateLimits.get(keyIdx);
  if (!modelLimits) {
    logger.error(`Rate-limit tracking not initialised for key ${keyIdx}`);
    return;
  }

  const now = Date.now();
  let data = modelLimits.get(modelName);

  if (!data) {
    modelLimits.set(modelName, { count: 1, windowStart: now });
    return;
  }

  if (now - data.windowStart >= RATE_LIMIT_CONFIG.WINDOW_DURATION_MS) {
    data.count = 1;
    data.windowStart = now;
  } else {
    data.count++;
  }

  modelLimits.set(modelName, data);
}

/**
 * Put a model on cooldown for the current key.
 * @param {number} keyIdx
 * @param {string} modelName
 * @param {number} [cooldownMs]
 */
function setModelCooldown(keyIdx, modelName, cooldownMs = RATE_LIMIT_CONFIG.COOLDOWN_DURATION_MS) {
  const modelCooldowns = keyModelCooldowns.get(keyIdx);
  if (!modelCooldowns) {
    logger.error(`Cooldown tracking not initialised for key ${keyIdx}`);
    return;
  }
  modelCooldowns.set(modelName, Date.now() + cooldownMs);
  logger.warn(`Key ${keyIdx + 1} / Model ${modelName} on ${cooldownMs / 1000}s cooldown`);
}

/**
 * Check whether a model is still within its cooldown window on a key.
 * @param {number} keyIdx
 * @param {string} modelName
 * @returns {boolean}
 */
function isModelOnCooldown(keyIdx, modelName) {
  const modelCooldowns = keyModelCooldowns.get(keyIdx);
  if (!modelCooldowns) return false;
  return Date.now() < (modelCooldowns.get(modelName) || 0);
}

// ============================================================================
// FALLBACK DISCOVERY
// ============================================================================

/**
 * Find the next model in the fallback chain that is neither rate-limited nor
 * on cooldown for the currently active key.
 *
 * @param {string} currentModelName
 * @returns {string|null} Next available model name, or `null` if all are exhausted.
 */
function findAvailableModel(currentModelName) {
  const startIdx = MODEL_FALLBACK_CHAIN.indexOf(currentModelName);

  for (let i = 1; i < MODEL_FALLBACK_CHAIN.length; i++) {
    const candidate = MODEL_FALLBACK_CHAIN[(startIdx + i) % MODEL_FALLBACK_CHAIN.length];

    if (isModelOnCooldown(currentKeyIdx, candidate)) {
      logger.debug(`Model ${candidate} on cooldown for Key ${currentKeyIdx + 1}`);
      continue;
    }
    if (isModelRateLimited(currentKeyIdx, candidate)) {
      logger.debug(`Model ${candidate} rate-limited for Key ${currentKeyIdx + 1}`);
      continue;
    }

    logger.info(`Found available fallback model: ${candidate} on Key ${currentKeyIdx + 1}`);
    return candidate;
  }

  return null;
}

/**
 * Find the next API key that is not on a global cooldown.
 * Starts looking from the key AFTER the current one.
 *
 * @returns {number|null} Key index, or `null` if all keys are on cooldown.
 */
function findAvailableKey() {
  const now = Date.now();

  for (let i = 1; i <= apiKeys.length; i++) {
    const testIdx = (currentKeyIdx + i) % apiKeys.length;
    const cooldownUntil = keyCooldowns.get(testIdx) || 0;
    if (now < cooldownUntil) continue;
    return testIdx;
  }

  return null;
}

// ============================================================================
// PUBLIC SWITCH HELPERS (used by other modules when they encounter errors)
// ============================================================================

/**
 * Intelligent switch: tries a model fallback first; falls back to key rotation
 * only when all models on the current key are exhausted.
 *
 * File-permission errors (403 on files) are explicitly handled — they do NOT
 * trigger rotation because Gemini files are tied to the uploading key.
 *
 * @param {Error} error - Error that triggered the switch.
 * @param {string} currentModelName - Model that encountered the error.
 * @returns {{keyRotated: boolean, modelChanged: boolean, newModel: string|null}}
 */
export async function switchToNextKeyOrModel(error, currentModelName) {
  const oldKeyIdx = currentKeyIdx;

  const isRateLimit =
    error?.status === 429 ||
    error?.code === 'RESOURCE_EXHAUSTED' ||
    (error?.message?.includes('429') && !error?.message?.includes('File')) ||
    error?.message?.includes('RESOURCE_EXHAUSTED') ||
    error?.message?.includes('quota');

  const isFileError =
    (error?.status === 403 || error?.code === 403 || error?.message?.includes('403')) &&
    (error?.message?.includes('File') ||
     error?.message?.includes('file') ||
     error?.message?.includes('PERMISSION_DENIED'));

  // Files are bound to the key that uploaded them — never rotate on file errors.
  if (isFileError) {
    logger.warn(`File permission error on Key ${oldKeyIdx + 1} — NOT rotating (files are key-specific)`);
    return { keyRotated: false, modelChanged: false, newModel: null };
  }

  if (isRateLimit) {
    setModelCooldown(oldKeyIdx, currentModelName);

    // Step 1 — try another model on the same key.
    const nextModel = findAvailableModel(currentModelName);
    if (nextModel) {
      logger.info(`Rate limit → fallback model: ${nextModel} (Key ${oldKeyIdx + 1} retained)`);
      return { keyRotated: false, modelChanged: true, newModel: nextModel };
    }

    // Step 2 — all models exhausted on this key; try rotating.
    logger.warn(`All models exhausted on Key ${oldKeyIdx + 1} — attempting key rotation`);
    const nextKeyIdx = findAvailableKey();

    if (nextKeyIdx !== null && nextKeyIdx !== oldKeyIdx) {
      currentKeyIdx = nextKeyIdx;
      currentClient = new GoogleGenAI({ apiKey: apiKeys[currentKeyIdx] });
      logger.info(`Rotated to Key ${nextKeyIdx + 1}, continuing with model: ${currentModelName}`);
      // Brief hold after key switch — prevents hammering the new key with queued messages.
      // KEY_SWITCH_HOLD_MS is configured in modules/config.js.
      if (KEY_SWITCH_HOLD_MS > 0) {
        await new Promise(r => setTimeout(r, KEY_SWITCH_HOLD_MS));
      }
      return { keyRotated: true, modelChanged: false, newModel: currentModelName };
    }

    // Step 3 — all keys exhausted; use fallback model as last resort.
    logger.warn('ALL keys exhausted — using fallback model as last resort');
    const fallbackIdx = (MODEL_FALLBACK_CHAIN.indexOf(currentModelName) + 1) % MODEL_FALLBACK_CHAIN.length;
    return { keyRotated: false, modelChanged: true, newModel: MODEL_FALLBACK_CHAIN[fallbackIdx] };
  }

  // Non-rate-limit error — track it and leave key/model unchanged.
  const tracking = keyErrorTracking.get(oldKeyIdx);
  if (tracking) {
    tracking.lastError = { message: error?.message || 'Unknown', timestamp: new Date().toISOString() };
  }

  logger.warn(`Non-rate-limit error on Key ${oldKeyIdx + 1} / Model ${currentModelName}: ${error?.message || String(error) || 'Unknown'}`);
  return { keyRotated: false, modelChanged: false, newModel: null };
}

/**
 * Backward-compatible wrapper around `switchToNextKeyOrModel`.
 * @deprecated Use `switchToNextKeyOrModel` directly.
 * @param {Error} [error]
 * @returns {Promise<boolean>}
 */
export async function switchToNextKey(error) {
  const result = await switchToNextKeyOrModel(error || new Error('Manual switch'), DEFAULT_MODEL);
  return result.keyRotated || result.modelChanged;
}

/**
 * Force-rotate to the next available API key regardless of rate-limit state.
 * Used by the dashboard's manual "Rotate Key" action.
 * @returns {boolean} true if rotated, false if only one key or all on cooldown
 */
export function rotateToNextKey() {
  const nextIdx = findAvailableKey();
  const targetIdx = (nextIdx !== null && nextIdx !== currentKeyIdx)
    ? nextIdx
    : (currentKeyIdx + 1) % apiKeys.length;
  if (targetIdx === currentKeyIdx && apiKeys.length === 1) {
    logger.warn('Only one API key configured — cannot rotate');
    return false;
  }
  currentKeyIdx = targetIdx;
  currentClient = new GoogleGenAI({ apiKey: apiKeys[currentKeyIdx] });
  logger.info(`Dashboard: manually rotated to Key ${currentKeyIdx + 1}`);
  return true;
}

// ============================================================================
// CORE RETRY ENGINE
// ============================================================================

/**
 * Execute an API call with automatic per-model rate limiting, exponential
 * back-off, and intelligent key rotation.
 *
 * Algorithm:
 *  1. If current key has hit MAX_ATTEMPTS_PER_KEY → rotate key and reset.
 *  2. If current model is proactively rate-limited → try next model.
 *  3. Execute `apiCall(currentModel)`.
 *  4. On 429 → put model on cooldown, try next model; if none → exhaust key.
 *  5. On file-403 → wait briefly, retry same key/model (never rotate).
 *  6. On transient API error (5xx, network) → wait + retry.
 *  7. On local JS error (no status/code) → throw immediately (no point retrying).
 *
 * @param {(modelName: string) => Promise<any>} apiCall
 * @param {string} initialModelName
 * @returns {Promise<any>}
 * @throws {Error} When all retry attempts are exhausted.
 */
export async function withRetryPerModel(apiCall, initialModelName) {
  let totalAttempts  = 0;
  const maxTotal     = RETRY_STRATEGY.MAX_TOTAL_ATTEMPTS;
  let currentModel   = initialModelName;

  /** Tracks per-key attempt counts so we rotate after MAX_ATTEMPTS_PER_KEY. */
  const attemptsPerKey = new Map();
  apiKeys.forEach((_, i) => attemptsPerKey.set(i, 0));

  while (totalAttempts < maxTotal) {
    const currentKey  = currentKeyIdx;
    const keyAttempts = attemptsPerKey.get(currentKey) || 0;

    // ── KEY EXHAUSTION CHECK ─────────────────────────────────────────────────
    if (keyAttempts >= RETRY_STRATEGY.MAX_ATTEMPTS_PER_KEY) {
      const nextKeyIdx = findAvailableKey();

      if (nextKeyIdx !== null && nextKeyIdx !== currentKey) {
        currentKeyIdx = nextKeyIdx;
        currentClient = new GoogleGenAI({ apiKey: apiKeys[currentKeyIdx] });
        attemptsPerKey.set(currentKeyIdx, 0);
        currentModel = initialModelName; // fresh key → reset to preferred model
        logger.info(`Key ${currentKey + 1} exhausted (${keyAttempts} tries) → rotating to Key ${currentKeyIdx + 1}`);
        if (KEY_SWITCH_HOLD_MS > 0) await new Promise(r => setTimeout(r, KEY_SWITCH_HOLD_MS));
        continue;
      } else {
        throw new Error(
          `Exhausted ${RETRY_STRATEGY.MAX_ATTEMPTS_PER_KEY} attempts on Key ` +
          `${currentKey + 1} and no other keys are available.`
        );
      }
    }

    try {
      // ── GEMMA DAILY LIMIT PRE-CHECK ────────────────────────────────────────
      if (isGemmaModel(currentModel) && isGemmaKeyExhausted(currentKeyIdx)) {
        logger.warn(`Gemma Key ${currentKeyIdx + 1} daily limit reached before request`);
        const nextKey = apiKeys.findIndex((_, i) => i !== currentKeyIdx && !isGemmaKeyExhausted(i));
        if (nextKey !== -1) {
          currentKeyIdx = nextKey;
          currentClient = new GoogleGenAI({ apiKey: apiKeys[currentKeyIdx] });
          logger.info(`Gemma pre-rotated to Key ${currentKeyIdx + 1}`);
          if (KEY_SWITCH_HOLD_MS > 0) await new Promise(r => setTimeout(r, KEY_SWITCH_HOLD_MS));
          continue;
        }
        throw new Error('All Gemma API keys have reached their daily limit (1500 req/key). Resets at midnight UTC.');
      }

      // ── PROACTIVE RATE-LIMIT CHECK ─────────────────────────────────────────
      if (isModelRateLimited(currentKeyIdx, currentModel)) {
        logger.warn(`Key ${currentKeyIdx + 1} / Model ${currentModel} hit RPM limit`);

        const nextModel = findAvailableModel(currentModel);
        if (nextModel) {
          currentModel = nextModel;
          logger.info(`Switched to fallback model: ${currentModel} (Key ${currentKeyIdx + 1} retained)`);
          continue;
        }

        // All models rate-limited → force key rotation via exhaustion flag.
        logger.warn(`All models rate-limited on Key ${currentKeyIdx + 1} — forcing rotation`);
        attemptsPerKey.set(currentKey, RETRY_STRATEGY.MAX_ATTEMPTS_PER_KEY);
        continue;
      }

      // ── TRACK USAGE ────────────────────────────────────────────────────────
      incrementModelRateLimit(currentKeyIdx, currentModel);
      const stats = keyUsageStats.get(currentKeyIdx);
      if (stats) { stats.requests++; stats.lastUsed = Date.now(); }

      // ── EXECUTE ────────────────────────────────────────────────────────────
      const result = await apiCall(currentModel);

      if (stats) stats.successfulRequests++;

      // Gemma: track daily usage per key, rotate key if limit hit (no model fallback).
      if (isGemmaModel(currentModel)) {
        incrementGemmaDailyCount(currentKeyIdx);
        if (isGemmaKeyExhausted(currentKeyIdx)) {
          logger.warn(`Gemma Key ${currentKeyIdx + 1} hit daily limit (${GEMMA_DAILY_LIMIT_PER_KEY}) — rotating key`);
          const nextKey = apiKeys.findIndex((_, i) => i !== currentKeyIdx && !isGemmaKeyExhausted(i));
          if (nextKey !== -1) {
            currentKeyIdx = nextKey;
            currentClient = new GoogleGenAI({ apiKey: apiKeys[currentKeyIdx] });
            logger.info(`Gemma rotated to Key ${currentKeyIdx + 1}`);
            if (KEY_SWITCH_HOLD_MS > 0) await new Promise(r => setTimeout(r, KEY_SWITCH_HOLD_MS));
          } else {
            logger.warn('All Gemma keys exhausted for today');
          }
        }
        return result;
      }

      // Proactive model switch after call-count threshold.
      const newCount = (modelGlobalCallCounts.get(currentModel) || 0) + 1;
      modelGlobalCallCounts.set(currentModel, newCount);
      const callThreshold = MODEL_CALL_THRESHOLDS?.[currentModel];
      if (callThreshold && newCount >= callThreshold) {
        const nextIdx  = (MODEL_FALLBACK_CHAIN.indexOf(currentModel) + 1) % MODEL_FALLBACK_CHAIN.length;
        const nextModel = MODEL_FALLBACK_CHAIN[nextIdx];
        if (nextModel && nextModel !== currentModel) {
          logger.info(`Proactive switch: ${currentModel} hit ${callThreshold} calls → ${nextModel}`);
          modelGlobalCallCounts.set(currentModel, 0);
          setModelCooldown(currentKeyIdx, currentModel, RATE_LIMIT_CONFIG.COOLDOWN_DURATION_MS);
        }
      }

      return result;

    } catch (error) {
      totalAttempts++;
      const keyTries = (attemptsPerKey.get(currentKey) || 0) + 1;
      attemptsPerKey.set(currentKey, keyTries);

      const stats = keyUsageStats.get(currentKeyIdx);
      if (stats) stats.errors++;

      logger.warn(
        `Attempt ${totalAttempts}/${maxTotal} ` +
        `(Key ${currentKeyIdx + 1}, Try ${keyTries}/${RETRY_STRATEGY.MAX_ATTEMPTS_PER_KEY}) ` +
        `failed: ${sanitizeErrorMessage(error.message)}`
      );

      const isRateLimit =
        error?.status === 429 ||
        error?.code === 'RESOURCE_EXHAUSTED' ||
        (error?.message?.includes('429') && !error?.message?.includes('File')) ||
        error?.message?.includes('RESOURCE_EXHAUSTED') ||
        error?.message?.includes('quota');

      const isFileError =
        (error?.status === 403 || error?.code === 403 || error?.message?.includes('403')) &&
        (error?.message?.includes('File') ||
         error?.message?.includes('file') ||
         error?.message?.includes('PERMISSION_DENIED'));

      // File-permission errors are key-specific — never rotate, just wait once.
      if (isFileError) {
        logger.warn('File permission error — NOT rotating; brief wait before retry');
        if (totalAttempts >= maxTotal) throw error;
        await new Promise(r => setTimeout(r, 1_000));
        continue;
      }

      if (isRateLimit) {
        setModelCooldown(currentKey, currentModel);
        const nextModel = findAvailableModel(currentModel);

        if (nextModel) {
          currentModel = nextModel;
          logger.info(`Rate limit → fallback model: ${currentModel} (Key ${currentKeyIdx + 1} retained)`);
        } else {
          logger.warn(`All models exhausted on Key ${currentKeyIdx + 1} — marking for rotation`);
          attemptsPerKey.set(currentKey, RETRY_STRATEGY.MAX_ATTEMPTS_PER_KEY);
        }

        await new Promise(r => setTimeout(r, RATE_LIMIT_CONFIG.RETRY_DELAYS.RATE_LIMIT));
        continue;
      }

      // Local JS errors have no HTTP status/code — these are bugs, not transient failures.
      const isApiError =
        error?.status || error?.code ||
        error?.message?.includes('fetch')   ||
        error?.message?.includes('network') ||
        error?.message?.includes('timeout') ||
        error?.message?.includes('500')     ||
        error?.message?.includes('503')     ||
        error?.message?.includes('502');

      if (!isApiError) throw error; // local crash — retrying would just mask bugs

      // 400 INVALID_ARGUMENT errors are permanent — retrying wastes all quota.
      // Common cause: thought_signature / id fields sent to a model that doesn't support them.
      const isInvalidArgument =
        error?.status === 400 ||
        error?.code === 400 ||
        error?.message?.includes('400') ||
        error?.message?.includes('INVALID_ARGUMENT') ||
        error?.message?.includes('context circulation');

      if (isInvalidArgument) throw error;

      if (totalAttempts >= maxTotal) {
        throw new Error(
          `All ${maxTotal} retry attempts exhausted. Last error: ${sanitizeErrorMessage(error.message)}`
        );
      }

      const delay =
        error?.message?.includes('500') || error?.message?.includes('503')
          ? RATE_LIMIT_CONFIG.RETRY_DELAYS.SERVER_ERROR
          : RATE_LIMIT_CONFIG.RETRY_DELAYS.DEFAULT;

      await new Promise(r => setTimeout(r, delay + Math.random() * 500));
    }
  }

  throw new Error(`Retry loop exited unexpectedly after ${totalAttempts} attempts`);
}

/**
 * Legacy wrapper — routes through `withRetryPerModel` with the default model.
 * @deprecated Use `withRetryPerModel` directly.
 * @param {() => Promise<any>} apiCall
 */
export async function withRetry(apiCall) {
  return withRetryPerModel(() => apiCall(), DEFAULT_MODEL);
}

// ============================================================================
// CURRENT CLIENT ACCESSOR (used by BotManager to build the genAI proxy)
// ============================================================================

/**
 * Get the currently active GoogleGenAI client.
 * @returns {GoogleGenAI}
 */
export function getCurrentClient() {
  return currentClient;
}

// ============================================================================
// STATISTICS
// ============================================================================

/**
 * Get a comprehensive, read-only snapshot of all key statistics including
 * per-model rate-limit data.
 *
 * @returns {{
 *   totalKeys: number,
 *   currentKey: number,
 *   rateLimit: string,
 *   effectiveCapacity: string,
 *   keys: Array<{
 *     keyNumber: number,
 *     keyPreview: string,
 *     isCurrent: boolean,
 *     status: string,
 *     totalRequests: number,
 *     successfulRequests: number,
 *     errors: number,
 *     lastUsed: string,
 *     lastError: string|null,
 *     modelStats: Array
 *   }>
 * }}
 */

/** Returns the total number of loaded API keys. */
/**
 * Serialize per-key request stats + Gemma daily counts to a plain object
 * so they can be persisted in runtime-config.json across restarts.
 */
export function dumpKeyStats() {
  const usage = {};
  keyUsageStats.forEach((v, k) => { usage[k] = { ...v }; });

  const gemma = {};
  gemmaKeyDailyCounts.forEach((v, k) => { gemma[k] = v; });

  return { usage, gemma, savedAt: Date.now() };
}

/**
 * Restore per-key stats from a previously dumped snapshot.
 * Called once on startup, before any requests are processed.
 *
 * @param {ReturnType<dumpKeyStats>} snapshot
 */
export function loadKeyStats(snapshot) {
  if (!snapshot) return;
  const { usage = {}, gemma = {} } = snapshot;

  for (const [k, v] of Object.entries(usage)) {
    const idx = Number(k);
    if (keyUsageStats.has(idx)) {
      keyUsageStats.set(idx, {
        requests:           v.requests           || 0,
        lastUsed:           v.lastUsed           || null,
        errors:             v.errors             || 0,
        successfulRequests: v.successfulRequests || 0,
      });
    }
  }

  for (const [k, v] of Object.entries(gemma)) {
    const idx = Number(k);
    if (gemmaKeyDailyCounts.has(idx)) {
      gemmaKeyDailyCounts.set(idx, v || 0);
    }
  }
}

export function getApiKeyCount() {
  return apiKeys.length;
}

export function getApiKeyStats() {
  const now   = Date.now();
  const stats = [];

  apiKeys.forEach((key, idx) => {
    const keyStats  = keyUsageStats.get(idx);
    const tracking  = keyErrorTracking.get(idx);
    const cooldown  = keyCooldowns.get(idx);
    const onCooldown = cooldown && now < cooldown;

    const modelStats = [];
    const modelLimits    = keyModelRateLimits.get(idx);
    const modelCooldowns = keyModelCooldowns.get(idx);

    if (modelLimits) {
      MODEL_FALLBACK_CHAIN.forEach(modelName => {
        const limitData     = modelLimits.get(modelName);
        const cooldownUntil = modelCooldowns?.get(modelName) || 0;
        const isModelCool   = now < cooldownUntil;
        const isModelLim    = limitData && isModelRateLimited(idx, modelName);

        let secUntilReset = 0;
        if (limitData) {
          secUntilReset = Math.ceil(
            Math.max(0, RATE_LIMIT_CONFIG.WINDOW_DURATION_MS - (now - limitData.windowStart)) / 1000
          );
        }

        modelStats.push({
          model:              modelName,
          requestsThisMinute: limitData?.count || 0,
          rateLimited:        isModelLim,
          cooldown:           isModelCool,
          secondsUntilReset:  isModelLim ? secUntilReset : 0
        });
      });
    }

    let status = '🟢 Active';
    if (onCooldown) {
      status = '🔴 Key Cooldown';
    } else if (modelStats.some(m => m.rateLimited || m.cooldown)) {
      status = '🟡 Partially Limited';
    }

    stats.push({
      keyNumber:          idx + 1,
      keyPreview:         `${key.slice(0, 8)}...`,
      isCurrent:          idx === currentKeyIdx,
      status,
      totalRequests:      keyStats?.requests           || 0,
      successfulRequests: keyStats?.successfulRequests || 0,
      errors:             keyStats?.errors             || 0,
      lastUsed:           keyStats?.lastUsed ? new Date(keyStats.lastUsed).toISOString() : 'Never',
      lastError:          tracking?.lastError?.message || null,
      modelStats
    });
  });

  return {
    totalKeys:         apiKeys.length,
    currentKey:        currentKeyIdx + 1,
    rateLimit:         `${RATE_LIMIT_CONFIG.REQUESTS_PER_MINUTE} req/min per model per key`,
    effectiveCapacity: `${RATE_LIMIT_CONFIG.REQUESTS_PER_MINUTE * MODEL_FALLBACK_CHAIN.length} req/min per key (${MODEL_FALLBACK_CHAIN.length} models)`,
    keys:              stats
  };
}
