import {
  setSafetyThresholdOverrides as setModuleSafetyThresholdOverrides,
  DEFAULT_SAFETY_THRESHOLDS,
  PDF_ENABLED_FOR_GEMINI, CROSS_CONTEXT_ENABLED,
  ENABLE_IMAGE_PROCESSING, ENABLE_VIDEO_PROCESSING, ENABLE_AUDIO_PROCESSING,
  ENABLE_FILE_PROCESSING, ENABLE_WEB_SEARCH, ENABLE_FUNCTION_CALLING,
} from '../modules/config.js';

/**
 * Validated process-local view of mutable AI runtime settings.
 * Persistence is owned by the runtime-config repository in dashboard/server.js;
 * this module is the single read/write interface used by message handling and API
 * controllers. Secrets are intentionally outside this registry.
 */
const MAX_PROMPT_LENGTH = 16_000;
const THRESHOLDS = new Set([
  'BLOCK_NONE',
  'BLOCK_ONLY_HIGH',
  'BLOCK_MEDIUM_AND_ABOVE',
  'BLOCK_LOW_AND_ABOVE',
  'OFF',
]);
const SAFETY_CATEGORIES = Object.freeze(Object.keys(DEFAULT_SAFETY_THRESHOLDS));
const FEATURE_FLAG_DEFAULTS = Object.freeze({
  PDF_ENABLED_FOR_GEMINI,
  CROSS_CONTEXT_ENABLED,
  ENABLE_IMAGE_PROCESSING,
  ENABLE_VIDEO_PROCESSING,
  ENABLE_AUDIO_PROCESSING,
  ENABLE_FILE_PROCESSING,
  ENABLE_WEB_SEARCH,
  ENABLE_FUNCTION_CALLING,
});
const FEATURE_FLAG_NAMES = Object.freeze(Object.keys(FEATURE_FLAG_DEFAULTS));

const settings = {
  activeModel: null,
  systemPrompt: null,
  defaultPersonality: null,
  safetyThresholds: Object.freeze({ ...DEFAULT_SAFETY_THRESHOLDS }),
  featureFlags: Object.freeze({ ...FEATURE_FLAG_DEFAULTS }),
};

function normalizePrompt(value, key) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') throw new TypeError(`${key} must be a string or null`);
  if (value.length > MAX_PROMPT_LENGTH) throw new RangeError(`${key} exceeds ${MAX_PROMPT_LENGTH} characters`);
  return value;
}

export function setRuntimeModel(model, validModels) {
  if (model === null || model === undefined || model === '') {
    settings.activeModel = null;
    return null;
  }
  if (typeof model !== 'string' || !validModels.includes(model)) {
    const error = new Error('Unsupported model. Select a model from the registered model list.');
    error.code = 'INVALID_MODEL';
    throw error;
  }
  settings.activeModel = model;
  return model;
}

export function setPromptOverrides({ systemPrompt, defaultPersonality } = {}) {
  if (systemPrompt !== undefined) settings.systemPrompt = normalizePrompt(systemPrompt, 'systemPrompt');
  if (defaultPersonality !== undefined) settings.defaultPersonality = normalizePrompt(defaultPersonality, 'defaultPersonality');
  return getRuntimeSettings();
}

export function setSafetyThresholdOverrides(overrides = {}) {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new TypeError('safetyThresholds must be an object');
  }
  const next = { ...DEFAULT_SAFETY_THRESHOLDS, ...settings.safetyThresholds };
  for (const [category, threshold] of Object.entries(overrides)) {
    if (!SAFETY_CATEGORIES.includes(category)) throw new TypeError(`Unsupported safety category: ${category}`);
    if (threshold === null || threshold === '') {
      next[category] = DEFAULT_SAFETY_THRESHOLDS[category];
      continue;
    }
    if (!THRESHOLDS.has(threshold)) throw new TypeError(`Unsupported safety threshold for ${category}`);
    next[category] = threshold;
  }
  // The AI request config and API registry share one validation entry point so
  // changes made in the console are applied to subsequent model requests.
  setModuleSafetyThresholdOverrides(next);
  settings.safetyThresholds = Object.freeze(next);
  return { ...settings.safetyThresholds };
}


/** Update only registered feature flags; arbitrary runtime properties are rejected. */
export function setRuntimeFeatureFlags(overrides = {}) {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new TypeError('featureFlags must be an object');
  }
  const next = { ...settings.featureFlags };
  for (const [name, value] of Object.entries(overrides)) {
    if (!FEATURE_FLAG_NAMES.includes(name)) throw new TypeError(`Unsupported feature flag: ${name}`);
    if (typeof value !== 'boolean') throw new TypeError(`${name} must be a boolean`);
    next[name] = value;
  }
  settings.featureFlags = Object.freeze(next);
  return { ...settings.featureFlags };
}

export function getRuntimeFeatureFlags() {
  return { ...settings.featureFlags };
}

export function getRuntimeFeatureFlag(name) {
  return Object.hasOwn(settings.featureFlags, name) ? settings.featureFlags[name] : false;
}

export function resetRuntimeFeatureFlags() {
  settings.featureFlags = Object.freeze({ ...FEATURE_FLAG_DEFAULTS });
  return getRuntimeFeatureFlags();
}

export function loadRuntimeSettings(source = {}, validModels = []) {
  // Only known fields are accepted. Unknown fields, especially internal key
  // counters and arbitrary objects, are intentionally ignored.
  const model = typeof source.activeModel === 'string' ? source.activeModel : null;
  if (model && validModels.includes(model)) settings.activeModel = model;
  else if (model) settings.activeModel = null;
  else settings.activeModel = null;
  try {
    setPromptOverrides({
      systemPrompt: source.systemPrompt ?? null,
      defaultPersonality: source.defaultPersonality ?? null,
    });
  } catch {
    // Corrupt/obsolete persisted overrides must not prevent boot. Reset to the
    // source-defined prompts rather than accepting an arbitrary config object.
    setPromptOverrides({ systemPrompt: null, defaultPersonality: null });
  }
  try {
    const candidate = source.safetyThresholds && typeof source.safetyThresholds === 'object'
      ? source.safetyThresholds : {};
    setSafetyThresholdOverrides(candidate);
  } catch {
    // Fail to safe provider defaults if persisted values are no longer supported.
    setSafetyThresholdOverrides({});
  }
  resetRuntimeFeatureFlags();
  try {
    const candidate = source.featureFlags && typeof source.featureFlags === 'object' ? source.featureFlags : {};
    setRuntimeFeatureFlags(candidate);
  } catch {
    // Invalid/stale feature flags revert to registered safe defaults at startup.
    resetRuntimeFeatureFlags();
  }
  return getRuntimeSettings();
}

export function getRuntimeSettings() {
  return {
    activeModel: settings.activeModel,
    systemPrompt: settings.systemPrompt,
    defaultPersonality: settings.defaultPersonality,
    safetyThresholds: { ...settings.safetyThresholds },
    featureFlags: { ...settings.featureFlags },
  };
}

export function getPromptOverrides() {
  return { systemPrompt: settings.systemPrompt, defaultPersonality: settings.defaultPersonality };
}

export function getActiveModel() {
  return settings.activeModel;
}

export function getSafetyThresholdOverrides() {
  return { ...settings.safetyThresholds };
}

export const RUNTIME_SETTING_SCHEMA = Object.freeze({
  activeModel: { type: 'registered-model-id', mutable: true },
  systemPrompt: { type: 'string|null', maxLength: MAX_PROMPT_LENGTH },
  defaultPersonality: { type: 'string|null', maxLength: MAX_PROMPT_LENGTH },
  safetyThresholds: { categories: SAFETY_CATEGORIES, allowedThresholds: [...THRESHOLDS] },
  featureFlags: { names: FEATURE_FLAG_NAMES, defaults: FEATURE_FLAG_DEFAULTS },
});
