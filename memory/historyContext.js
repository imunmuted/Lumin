/**
 * @fileoverview Pure helpers for constructing bounded text-only model history.
 *
 * This module intentionally has no database, Discord, SDK, or cache imports so
 * the context-size/security contract can be tested in isolation.
 */

const VALID_ROLES = new Set(['user', 'assistant', 'model']);
const MAX_CONTEXT_MESSAGES = 5;

export function extractText(message) {
  const parts = message?.content ?? message?.parts ?? [];
  if (typeof parts === 'string') return parts;
  if (!Array.isArray(parts)) return '';
  return parts.map((part) => typeof part?.text === 'string' ? part.text : '').filter(Boolean).join('\n');
}

export function flattenHistory(history) {
  if (Array.isArray(history)) return history.slice();
  if (!history || typeof history !== 'object') return [];
  const entries = [];
  for (const value of Object.values(history)) {
    if (Array.isArray(value)) entries.push(...value);
  }
  return entries;
}

/** Normalize valid saved messages to Gemini's `{ role, parts }` content shape. */
export function sanitizeForModel(messages) {
  const result = [];
  for (const message of messages) {
    const originalRole = message?.role;
    const role = originalRole === 'assistant' || originalRole === 'model' ? 'model' :
      originalRole === 'user' ? 'user' : null;
    const text = extractText(message);
    if (!role || !text.trim()) continue;
    const previous = result.at(-1);
    if (previous?.role === role) previous.parts.push({ text });
    else result.push({ role, parts: [{ text }] });
  }
  // A historical Gemini conversation must begin with a user turn. The current
  // message is sent separately by the caller and is not inserted here.
  while (result.length && result[0].role !== 'user') result.shift();
  return result;
}

/** Return text context derived from no more than the latest five saved messages. */
export function getLatestModelContext(history, limit = MAX_CONTEXT_MESSAGES) {
  const safeLimit = Math.max(1, Math.min(MAX_CONTEXT_MESSAGES,
    Number.isFinite(Number(limit)) ? Math.floor(Number(limit)) : MAX_CONTEXT_MESSAGES));
  const eligible = flattenHistory(history)
    .filter((entry) => entry && VALID_ROLES.has(entry.role) && extractText(entry).trim())
    .sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0));
  return sanitizeForModel(eligible.slice(-safeLimit));
}
