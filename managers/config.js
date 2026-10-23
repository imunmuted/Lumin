// Managers folder config — re-exports from master modules/config.js.
// Import manager config from here rather than reaching up to ../modules/config.js.
export {
  BOT_CONFIG,
  STATE_CONFIG,
  RESOURCE_CONFIG,
  MIGRATION_CONFIG,
  POLL_CONFIG,
  DEFAULT_MODEL,
  SUPPORTED_MODEL_IDS,
  MAX_QUEUE_DEPTH_PER_USER,
  KEY_SWITCH_HOLD_MS,
  RAM_MEDIA_SUSPEND_THRESHOLD_MB,
  CACHE_ENABLED
} from '../modules/config.js';
