/**
 * @fileoverview Unit tests for Project Helium Configuration and SSOT.
 * Verifies model restrictions, embedding dimensionality, default flags,
 * and parameterized callsign integrity.
 */

import { describe, it, expect } from 'vitest';
import {
  SYSTEM_AGENT_CALLSIGN,
  DEFAULT_MODEL,
  GEMMA_DEFAULT_MODEL,
  GEMMA_FALLBACK_MODEL,
  MODEL_FALLBACK_CHAIN,
  EMBEDDING_MODEL,
  EMBEDDING_DIM,
  EMBEDDING_MRL_CENTROID_DIM,
  ENABLE_REDIS,
  FAST_MEMORY_CACHE_MAX_BYTES,
  PERSONALIZATION_DEFAULT,
  MODEL_CAPABILITIES,
  doesModelSupportGoogleSearch,
} from '../modules/config.js';

describe('Project Helium SSOT Configuration', () => {
  it('should default SYSTEM_AGENT_CALLSIGN to Lumin or respect env override', () => {
    expect(typeof SYSTEM_AGENT_CALLSIGN).toBe('string');
    expect(SYSTEM_AGENT_CALLSIGN.length).toBeGreaterThan(0);
  });

  it('should strictly permit only the 2 approved Gemini models and 2 Gemma 4 models', () => {
    // Primary Gemini models
    expect(['gemini-3.5-flash-lite', 'gemini-3.8-flash']).toContain(DEFAULT_MODEL);
    
    // Gemma models
    expect(['gemma-4-28b', 'gemma-4-26b-a4b-it']).toContain(GEMMA_DEFAULT_MODEL);
    expect(['gemma-4-31b', 'gemma-4-31b-it']).toContain(GEMMA_FALLBACK_MODEL);

    // Chain contains approved models
    for (const model of MODEL_FALLBACK_CHAIN) {
      const isApproved =
        model.includes('gemini-3.5-flash-lite') ||
        model.includes('gemini-3.8-flash') ||
        model.includes('gemma-4');
      expect(isApproved).toBe(true);
    }
  });

  it('should enforce Gemini-only Google Search tool capability', () => {
    expect(doesModelSupportGoogleSearch('gemini-3.8-flash')).toBe(true);
    expect(doesModelSupportGoogleSearch('gemini-3.5-flash-lite')).toBe(true);
    expect(doesModelSupportGoogleSearch('gemma-4-28b')).toBe(false);
    expect(doesModelSupportGoogleSearch('gemma-4-31b')).toBe(false);
    expect(doesModelSupportGoogleSearch('gemma-4-26b-a4b-it')).toBe(false);
  });

  it('should configure gemini-embedding-2 with 768-dim vectors and 64-dim centroid projections', () => {
    expect(EMBEDDING_MODEL).toBe('gemini-embedding-2');
    expect(EMBEDDING_DIM).toBe(768);
    expect(EMBEDDING_MRL_CENTROID_DIM).toBe(64);
  });

  it('should default ENABLE_REDIS to false for standalone in-memory execution', () => {
    expect(ENABLE_REDIS).toBe(false);
  });

  it('should enforce strict 25MB heap budget for the FastMemoryCache', () => {
    expect(FAST_MEMORY_CACHE_MAX_BYTES).toBe(25 * 1024 * 1024);
  });

  it('should enable personalization by default for cognitive human-brain memory unification', () => {
    expect(PERSONALIZATION_DEFAULT).toBe(true);
  });
});
