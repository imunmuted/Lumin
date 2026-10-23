/**
 * @fileoverview Compatibility wrapper for central Helium runtime feature flags.
 * All reads/writes are handled by the validated runtime registry; this module
 * intentionally does not read JSON from disk or maintain a second TTL cache.
 */
import { getRuntimeFeatureFlag, getRuntimeFeatureFlags } from '../../helium/runtimeRegistry.js';

export const getFlag = getRuntimeFeatureFlag;
export const getAllFlags = getRuntimeFeatureFlags;
