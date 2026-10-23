import express                        from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { spawn }                      from 'child_process';
import crypto                         from 'crypto';
import os                             from 'os';
import path                           from 'path';
import fs                             from 'fs';
import { fileURLToPath }              from 'url';

import {
  client,
  state,
  getApiKeyStats,
  switchToNextKey,
  rotateToNextKey,
  saveStateToFile,
  dumpKeyStats,
  loadKeyStats,
} from '../managers/BotManager.js';
import { DEFAULT_SERVER_SETTINGS, DEFAULT_USER_SETTINGS, getDefaultServerSettings, getDefaultUserSettings, getSettingDefaults, saveSettingDefaultsToDB } from '../managers/StateManager.js';
import * as db from '../database.js';
import { Logger } from '../core/Logger.js';
import { redisStore } from '../infra/RedisStore.js';
import { authorize, isIdentityAuthorized, PERMISSIONS, describeRoleHierarchy, requiredPermissionForRequest, getAccessibleGuildIds, getStaffRoleAssignments, getBestRoleAssignment, replaceStaffRoleAssignments } from '../security/authorization.js';
import { resolveContainedPath } from '../security/pathPolicy.js';
import { loadRuntimeSettings, getRuntimeSettings, getRuntimeFeatureFlags, setRuntimeFeatureFlags, resetRuntimeFeatureFlags, getActiveModel, getPromptOverrides, setRuntimeModel, setPromptOverrides, setSafetyThresholdOverrides } from '../helium/runtimeRegistry.js';
import { MODELS, MODEL_REGISTRY, SUPPORTED_MODEL_IDS, MODEL_FALLBACK_CHAIN, ENABLE_GEMMA, GEMMA_DEFAULT_MODEL, DEFAULT_MODEL } from '../modules/config.js';
import { commands } from '../commands.js';

const logger     = Logger.get('Dashboard');
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const ROOT_DIR   = path.resolve(__dirname, '..');

const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID     || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const GOOGLE_CALLBACK_URL  = process.env.GOOGLE_OAUTH_CALLBACK_URL || '';
const DISCORD_CLIENT_ID    = process.env.DISCORD_OAUTH_CLIENT_ID || '';
const DISCORD_CLIENT_SECRET = process.env.DISCORD_OAUTH_CLIENT_SECRET || '';
const DISCORD_CALLBACK_URL = process.env.DISCORD_OAUTH_CALLBACK_URL || '';
const CONSOLE_URL          = process.env.HELIUM_CONSOLE_URL || '/dashboard/';
const RECAPTCHA_SECRET     = process.env.RECAPTCHA_SECRET_KEY  || '';
const RECAPTCHA_SITE_KEY   = process.env.RECAPTCHA_SITE_KEY    || '';
const ALLOWED_EMAIL        = (process.env.HELIUM_OWNER_EMAIL || '').trim().toLowerCase();
const RECAPTCHA_REQUIRED   = process.env.HELIUM_RECAPTCHA_REQUIRED === 'true' || (process.env.NODE_ENV === 'production' && process.env.HELIUM_RECAPTCHA_REQUIRED !== 'false');
const RECAPTCHA_HOSTNAMES = new Set(String(process.env.HELIUM_CONSOLE_HOSTNAMES || '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean));
const SESSION_TTL          = 24 * 60 * 60 * 1000;
const SESSION_COOKIE       = 'helium_session';
const ENABLE_ADMIN_TERMINALS = process.env.HELIUM_ENABLE_ADMIN_TERMINALS === 'true';
const CONSOLE_ORIGINS = new Set(String(process.env.HELIUM_CONSOLE_ORIGINS || '').split(',').map(value => { try { return new URL(value.trim()).origin; } catch { return ''; } }).filter(Boolean));

// Least-privilege bot invite permissions. Deliberately excludes Administrator.
const BOT_INVITE_PERMISSIONS = [2n, 4n, 64n, 1024n, 2048n, 8192n, 16384n, 32768n, 65536n, 2147483648n, 1099511627776n]
  .reduce((permissions, bit) => permissions | bit, 0n).toString();
const createBotInviteLink = (clientId) => `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(clientId)}&permissions=${BOT_INVITE_PERMISSIONS}&scope=bot%20applications.commands`;

const RUNTIME_CONFIG_PATH  = path.join(__dirname, 'runtime-config.json');
const MODULES_CONFIG_PATH  = path.join(ROOT_DIR, 'modules', 'config.js');
const BASE_CONFIG_PATH     = path.join(ROOT_DIR, 'config.js');

if (!ALLOWED_EMAIL && !process.env.HELIUM_OWNER_DISCORD_ID && !process.env.HELIUM_STAFF_ROLES_JSON) logger.warn('No owner or staff identities configured; all console logins will be denied.');
if (process.env.NODE_ENV === 'production' && !GOOGLE_CALLBACK_URL && GOOGLE_CLIENT_ID) logger.error('GOOGLE_OAUTH_CALLBACK_URL is required in production; dynamic callback URL construction is disabled.');

if (state.globalLockdown === undefined) state.globalLockdown = false;
if (state.debugMode      === undefined) state.debugMode      = false;

let runtimeConfig = {};
try {
  if (fs.existsSync(RUNTIME_CONFIG_PATH)) {
    runtimeConfig = JSON.parse(fs.readFileSync(RUNTIME_CONFIG_PATH, 'utf8'));
  }
} catch {}

// Load only validated, explicitly supported runtime controls. Config file content
// never gets merged directly into model or security configuration.
loadRuntimeSettings(runtimeConfig, SUPPORTED_MODEL_IDS);
try { setSafetyThresholdOverrides(runtimeConfig.safetyThresholds || {}); } catch (error) { logger.warn(`Ignoring invalid persisted safety configuration: ${error.message}`); }

// Restore per-key request counts + Gemma daily counts from last run
if (runtimeConfig._keyStats) {
  try { loadKeyStats(runtimeConfig._keyStats); } catch {}
}

function saveRuntimeConfig() {
  const temporaryPath = `${RUNTIME_CONFIG_PATH}.${process.pid}.tmp`;
  try {
    // Always snapshot key stats before writing so they survive restarts. Write
    // atomically with restrictive permissions to avoid truncation on crashes.
    runtimeConfig._keyStats = dumpKeyStats();
    fs.writeFileSync(temporaryPath, JSON.stringify(runtimeConfig, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporaryPath, RUNTIME_CONFIG_PATH);
  } catch (error) {
    try { fs.rmSync(temporaryPath, { force: true }); } catch {}
    logger.error(`Could not persist runtime configuration: ${error.message}`);
  }
}

// Autosave key stats every 5 minutes so they survive hard crashes too
setInterval(saveRuntimeConfig, 5 * 60 * 1000).unref();

export { saveRuntimeConfig };

const sessions    = new Map();
const oauthStates = new Map();
const captchaTickets = new Map();
let roleAssignmentsReady = Promise.resolve();

function makeToken() { return crypto.randomBytes(32).toString('hex'); }
function parseCookies(header) {
  if (!header) return {};
  const result = {};
  for (const part of header.split(';')) {
    const split = part.indexOf('=');
    if (split <= 0) continue;
    const key = part.slice(0, split).trim();
    const value = part.slice(split + 1).trim();
    try { result[key] = decodeURIComponent(value); } catch { /* reject malformed cookie value */ }
  }
  return result;
}
function getSessionToken(req) {
  const cookies = parseCookies(req.headers.cookie);
  return cookies[SESSION_COOKIE] || cookies.lumin_session || null;
}
function lookupSession(token) {
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (Date.now() > session.expires) { sessions.delete(token); return null; }
  return session;
}
function issueSession(identity) {
  const token = makeToken();
  if (sessions.size >= 5_000) {
    const now = Date.now();
    for (const [key, session] of sessions) if (now > session.expires) sessions.delete(key);
    while (sessions.size >= 5_000) sessions.delete(sessions.keys().next().value);
  }
  sessions.set(token, { ...identity, csrfToken: makeToken(), expires: Date.now() + SESSION_TTL, createdAt: Date.now() });
  return token;
}
function serializeSessionCookie(token, req) {
  const rawSameSite = String(process.env.HELIUM_COOKIE_SAME_SITE || 'Lax');
  const sameSite = ['Lax', 'Strict', 'None'].includes(rawSameSite) ? rawSameSite : 'Lax';
  const secure = process.env.HELIUM_COOKIE_SECURE === 'true' || process.env.NODE_ENV === 'production' || sameSite.toLowerCase() === 'none';
  const securePart = secure ? '; Secure' : '';
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=${sameSite}; Max-Age=${Math.floor(SESSION_TTL / 1000)}${securePart}`;
}
function oauthStateCookieName(provider) { return `helium_oauth_${provider}`; }
function serializeOAuthStateCookie(provider, token) {
  const secure = process.env.HELIUM_COOKIE_SECURE === 'true' || process.env.NODE_ENV === 'production';
  return `${oauthStateCookieName(provider)}=${encodeURIComponent(token)}; Path=/dashboard/auth; HttpOnly; SameSite=Lax; Max-Age=600${secure ? '; Secure' : ''}`;
}
function expireOAuthStateCookie(provider) {
  const secure = process.env.HELIUM_COOKIE_SECURE === 'true' || process.env.NODE_ENV === 'production';
  return `${oauthStateCookieName(provider)}=; Path=/dashboard/auth; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
}
function serializeCaptchaCookie(ticket) {
  const secure = process.env.HELIUM_COOKIE_SECURE === 'true' || process.env.NODE_ENV === 'production';
  const sameSite = secure ? 'None' : 'Lax';
  return `helium_captcha_gate=${encodeURIComponent(ticket)}; Path=/dashboard/auth; HttpOnly; SameSite=${sameSite}; Max-Age=120${secure ? '; Secure' : ''}`;
}
function expireCaptchaCookie() {
  const secure = process.env.HELIUM_COOKIE_SECURE === 'true' || process.env.NODE_ENV === 'production';
  return `helium_captcha_gate=; Path=/dashboard/auth; HttpOnly; SameSite=${secure ? 'None' : 'Lax'}; Max-Age=0${secure ? '; Secure' : ''}`;
}
function captchaClientBinding(req) {
  const ip = String(req.ip || req.socket?.remoteAddress || 'unknown');
  const agent = String(req.headers['user-agent'] || 'unknown').slice(0, 512);
  return crypto.createHash('sha256').update(`${ip}\0${agent}`).digest('hex');
}
function consumeCaptchaTicket(req, provider) {
  if (!RECAPTCHA_REQUIRED) return true;
  const ticket = parseCookies(req.headers.cookie).helium_captcha_gate;
  if (typeof ticket !== 'string' || !ticket) return false;
  const record = captchaTickets.get(ticket);
  captchaTickets.delete(ticket); // ticket is single-use even if invalid
  return Boolean(record && record.provider === provider && record.expiresAt > Date.now() && record.binding === captchaClientBinding(req));
}
function constantTimeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function expireSessionCookies() {
  const secure = process.env.HELIUM_COOKIE_SECURE === 'true' || process.env.NODE_ENV === 'production';
  const suffix = secure ? '; Secure' : '';
  return [
    `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${suffix}`,
    `lumin_session=; Path=/dashboard; HttpOnly; SameSite=Lax; Max-Age=0${suffix}`,
  ];
}
function isConsoleOriginAllowed(origin, req) {
  if (!origin) return true; // non-browser API clients still need a valid session
  if (CONSOLE_ORIGINS.has(origin)) return true;
  const configuredApiOrigin = process.env.HELIUM_API_PUBLIC_ORIGIN || '';
  try { return Boolean(configuredApiOrigin) && new URL(origin).origin === new URL(configuredApiOrigin).origin; } catch { return false; }
}
function isWebSocketOriginAllowed(origin) {
  try { return CONSOLE_ORIGINS.has(new URL(origin).origin); } catch { return false; }
}

function apiCors(req, res, next) {
  const origin = req.headers.origin;
  if (!isConsoleOriginAllowed(origin, req)) return res.status(403).json({ error: 'Origin is not allowed for this console API.' });
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Requested-With, X-CSRF-Token');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
}
function getRequestGuildId(req) {
  const explicit = req.params?.guildId || req.body?.guildId || req.query?.guildId || req.params?.serverId || req.body?.serverId || req.query?.serverId;
  if (!explicit && /\/(?:servers|guilds)(?:\/|$)/i.test(req.path) && /^\d{17,20}$/.test(String(req.params?.id || ''))) return String(req.params.id);
  if (explicit) return String(explicit);
  const routePath = String(req.originalUrl || req.path).replace(/^\/dashboard(?=\/|$)/, '').split('?')[0];
  const routeGuild = routePath.match(/\/(?:servers|guilds|guild-info|channels|members|server-settings|reset-server)\/(\d{17,20})(?:\/|$)/i)?.[1];
  if (routeGuild) return routeGuild;
  const channelId = req.body?.channelId || req.params?.channelId;
  if (channelId) return client?.channels?.cache?.get(String(channelId))?.guildId || null;
  return null;
}
async function loadPersistedRoleAssignments() {
  try {
    await db.connectDB();
    const database = db.getDB();
    const current = await database.collection('consoleRoleAssignmentState').findOne({ _id: 'active' });
    if (Array.isArray(current?.assignments)) {
      replaceStaffRoleAssignments(current.assignments);
      return;
    }
    // One-time backwards compatibility with the old per-assignment collection.
    const records = await database.collection('consoleRoleAssignments')
      .find({}, { projection: { _id: 0, identityType: 1, identity: 1, role: 1, level: 1, scope: 1, guildIds: 1 } })
      .limit(500).toArray();
    if (records.length) replaceStaffRoleAssignments(records);
  } catch (error) {
    logger.warn(`Could not load persisted console roles; environment role map remains active (${error.message})`);
  }
}

async function persistRoleAssignments(assignments, changedBy) {
  await db.connectDB();
  const stamped = assignments.map(grant => ({ ...grant, changedBy, updatedAt: new Date() }));
  // A single-document replacement is atomic; never delete the live role set
  // before writing its replacement.
  await db.getDB().collection('consoleRoleAssignmentState').replaceOne(
    { _id: 'active' },
    { _id: 'active', assignments: stamped, changedBy, updatedAt: new Date() },
    { upsert: true },
  );
}

function authorizeApiRequest(req, res, next) {
  const routePath = String(req.originalUrl || req.path).replace(/^\/dashboard(?=\/|$)/, '').split('?')[0];
  const discoveryRoutes = new Set(['/api/auth/permissions', '/api/cmd/servers', '/api/cmd/models', '/api/cmd/command-catalog']);
  if (req.method === 'GET' && discoveryRoutes.has(routePath) && isIdentityAuthorized(req.sessionUser)) {
    req.authorization = { allowed: true, role: getBestRoleAssignment(req.sessionUser), scopedDiscovery: true };
    return next();
  }
  const permission = requiredPermissionForRequest({ method: req.method, path: routePath });
  const guildId = getRequestGuildId(req);
  const result = authorize(req.sessionUser, permission, guildId);
  if (!result.allowed) {
    logger.warn(`Console authorization denied: ${req.method} ${req.path}; identity=${req.sessionUser?.email || req.sessionUser?.id || 'unknown'}; reason=${result.reason}`);
    return res.status(403).json({ error: 'Forbidden', code: result.reason, requiredPermission: permission });
  }
  req.authorization = result;
  next();
}
function authenticate(req, res, next) {
  const token = getSessionToken(req);
  const session = lookupSession(token);
  if (!session) return res.status(401).json({ error: 'Unauthorized' });
  session.expires = Date.now() + SESSION_TTL;
  req.sessionToken = token;
  req.sessionUser = session;
  next();
}
function requireCsrf(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method.toUpperCase())) return next();
  const supplied = req.get('X-CSRF-Token');
  if (!constantTimeEqual(supplied, req.sessionUser?.csrfToken)) {
    return res.status(403).json({ error: 'CSRF verification failed.', code: 'CSRF_INVALID' });
  }
  next();
}
function auditApiRequest(req, res, next) {
  const isRead = ['GET', 'HEAD', 'OPTIONS'].includes(req.method.toUpperCase());
  const routePath = String(req.originalUrl || req.path).split('?')[0]
    .replace(/\/\d{17,20}(?=\/|$)/g, '/:id');
  const isSensitiveRead = /\/(chat-history|all-histories|memory|usage-stats|api-key-stats|state-snapshot|audit\/logs)(?:\/|$)/.test(routePath);
  if (isRead && !isSensitiveRead) return next();
  const requestId = crypto.randomUUID();
  res.setHeader('X-Request-Id', requestId);
  res.on('finish', () => {
    // Do not log request bodies, OAuth tokens, prompts, or other user content.
    Promise.resolve().then(async () => {
      await db.connectDB();
      await db.getDB().collection('consoleAuditLogs').insertOne({
        requestId,
        actor: String(req.sessionUser?.email || req.sessionUser?.discordId || req.sessionUser?.id || 'unknown').slice(0, 320),
        provider: req.sessionUser?.provider || null,
        method: req.method,
        route: routePath.slice(0, 240),
        guildId: getRequestGuildId(req),
        permission: req.authorization?.allowed ? req.authorization?.role?.role || null : null,
        statusCode: res.statusCode,
        at: new Date(),
      });
    }).catch(error => logger.warn(`Could not persist console audit event: ${error.message}`));
  });
  next();
}
function safeCount(obj) { try { return Object.keys(obj||{}).length; } catch { return 0; } }

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index++; }
  return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${units[index]}`;
}

function getDiskUsage() {
  try {
    if (typeof fs.statfsSync !== 'function') return { available: false, used: '—', percent: '—', availableBytes: '—', reason: 'Disk usage metrics are unsupported on this runtime.' };
    const stats = fs.statfsSync(ROOT_DIR);
    const blockSize = Number(stats.bsize || 0);
    const total = Number(stats.blocks || 0) * blockSize;
    const free = Number(stats.bfree || 0) * blockSize;
    const availableBytes = Number(stats.bavail || 0) * blockSize;
    const used = Math.max(0, total - free);
    return { available: formatBytes(availableBytes), availableBytes, total, free, usedBytes: used, used: formatBytes(used), percent: total > 0 ? `${Math.round((used / total) * 100)}%` : '—' };
  } catch { return { available: false, used: '—', percent: '—', availableBytes: '—' }; }
}

const router = express.Router();
router.use('/auth', apiCors);

// Fix #4: Security headers middleware
router.use((_req, res, next) => {
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline' https://www.google.com https://www.gstatic.com; " +
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src 'self' https://fonts.gstatic.com; " +
    "img-src 'self' data: https:; " +
    "connect-src 'self' wss: ws:; " +
    "frame-src https://www.google.com;"
  );
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  next();
});

router.use(express.json({ limit: '1mb', strict: true }));

// Fix #6: Per-IP rate limiter for auth endpoints (10 req/min, 5-min auto-cleanup)
const localRateLimitHits = new Map();
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_KEYS = 10_000;

function consumeLocalRateLimit(key, limit, now = Date.now()) {
  if (localRateLimitHits.size >= RATE_LIMIT_MAX_KEYS) {
    for (const [existingKey, entry] of localRateLimitHits) {
      if (now >= entry.resetAt) localRateLimitHits.delete(existingKey);
    }
    if (localRateLimitHits.size >= RATE_LIMIT_MAX_KEYS) return false; // fail closed under a key-flood
  }
  let entry = localRateLimitHits.get(key);
  if (!entry || now >= entry.resetAt) {
    entry = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
    localRateLimitHits.set(key, entry);
  }
  entry.count += 1;
  return entry.count <= limit;
}

const authRateLimiter = async (req, res, next) => {
  const ip = String(req.ip || req.socket.remoteAddress || 'unknown').slice(0, 128);
  const key = `auth:${crypto.createHash('sha256').update(ip).digest('hex')}`;
  try {
    const distributedCount = await redisStore.consumeRateLimit(key, 60);
    const allowed = distributedCount === null
      ? consumeLocalRateLimit(key, 10)
      : distributedCount <= 10;
    if (!allowed) return res.status(429).json({ error: 'Too many authentication attempts. Please wait a minute.' });
    return next();
  } catch {
    if (!consumeLocalRateLimit(key, 10)) return res.status(429).json({ error: 'Too many authentication attempts. Please wait a minute.' });
    return next();
  }
};

const apiRateLimiter = async (req, res, next) => {
  const identity = req.sessionUser?.email || req.sessionUser?.discordId || req.sessionUser?.id || 'unknown';
  const key = `api:${crypto.createHash('sha256').update(String(identity)).digest('hex')}`;
  try {
    const distributedCount = await redisStore.consumeRateLimit(key, 60);
    const allowed = distributedCount === null
      ? consumeLocalRateLimit(key, 120)
      : distributedCount <= 120;
    if (!allowed) return res.status(429).json({ error: 'API rate limit exceeded. Retry after the current minute.' });
    return next();
  } catch {
    if (!consumeLocalRateLimit(key, 120)) return res.status(429).json({ error: 'API rate limit exceeded. Retry after the current minute.' });
    return next();
  }
};


router.get('/auth/config', (_req, res) => {
  res.json({
    recaptchaSiteKey: RECAPTCHA_SITE_KEY,
    recaptchaRequired: RECAPTCHA_REQUIRED,
    hasGoogleOAuth: Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && GOOGLE_CALLBACK_URL),
    hasDiscordOAuth: Boolean(DISCORD_CLIENT_ID && DISCORD_CLIENT_SECRET && DISCORD_CALLBACK_URL),
    consoleUrl: CONSOLE_URL,
  });
});

router.post('/auth/verify-recaptcha', authRateLimiter, async (req, res) => {
  const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
  const provider = req.body?.provider;
  if (!['google', 'discord'].includes(provider)) return res.status(400).json({ success: false, error: 'A supported OAuth provider is required.' });
  if (!RECAPTCHA_REQUIRED) return res.json({ success: true, skipped: true, score: null });
  if (!RECAPTCHA_SECRET || !RECAPTCHA_SITE_KEY || RECAPTCHA_HOSTNAMES.size === 0) {
    return res.status(503).json({ success: false, error: 'CAPTCHA is required but the site key, secret, or hostname allowlist is not configured.' });
  }
  if (!token || token.length > 8_192) return res.status(400).json({ success: false, error: 'A valid CAPTCHA token is required.' });
  try {
    const response = await fetch('https://www.google.com/recaptcha/api/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret: RECAPTCHA_SECRET, response: token, remoteip: String(req.ip || '') }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return res.status(502).json({ success: false, error: 'CAPTCHA provider is unavailable.' });
    const data = await response.json();
    const score = Number.isFinite(data.score) ? data.score : null;
    const expectedHost = typeof data.hostname === 'string' && RECAPTCHA_HOSTNAMES.has(data.hostname.toLowerCase());
    const validAction = data.action === 'login';
    const validScore = score !== null && score >= Number(process.env.HELIUM_RECAPTCHA_MIN_SCORE || 0.5);
    const success = data.success === true && expectedHost && validAction && validScore;
    if (!success) return res.status(400).json({ success: false, score, error: 'CAPTCHA verification failed.' });

    const now = Date.now();
    for (const [key, value] of captchaTickets) if (value.expiresAt <= now) captchaTickets.delete(key);
    while (captchaTickets.size >= 5_000) captchaTickets.delete(captchaTickets.keys().next().value);
    const ticket = makeToken();
    captchaTickets.set(ticket, { provider, binding: captchaClientBinding(req), expiresAt: now + 120_000 });
    res.append('Set-Cookie', serializeCaptchaCookie(ticket));
    res.json({ success: true, score });
  } catch {
    res.status(503).json({ success: false, error: 'CAPTCHA verification is temporarily unavailable.' });
  }
});

function consoleRedirect(status = '') {
  if (CONSOLE_URL.startsWith('/')) return `${CONSOLE_URL}${CONSOLE_URL.includes('?') ? '&' : '?'}auth=${encodeURIComponent(status)}`;
  try { const target = new URL(CONSOLE_URL); if (status) target.searchParams.set('auth', status); return target.toString(); }
  catch { return '/dashboard/'; }
}

function createOAuthState(provider, callbackUrl) {
  const state = makeToken();
  oauthStates.set(state, { provider, callbackUrl, created: Date.now() });
  const now = Date.now();
  for (const [key, value] of oauthStates) if (now - value.created > 600_000) oauthStates.delete(key);
  while (oauthStates.size > 2_000) oauthStates.delete(oauthStates.keys().next().value);
  return state;
}

router.get('/auth/google', authRateLimiter, (req, res) => {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_CALLBACK_URL) return res.status(503).send('Google OAuth is not fully configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_OAUTH_CALLBACK_URL.');
  if (!consumeCaptchaTicket(req, 'google')) return res.redirect(consoleRedirect('captcha_required'));
  if (RECAPTCHA_REQUIRED) res.append('Set-Cookie', expireCaptchaCookie());
  const callbackUrl = GOOGLE_CALLBACK_URL;
  const stateKey = createOAuthState('google', callbackUrl);
  res.append('Set-Cookie', serializeOAuthStateCookie('google', stateKey));
  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id',     GOOGLE_CLIENT_ID);
  authUrl.searchParams.set('redirect_uri',  callbackUrl);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope',         'openid email profile');
  authUrl.searchParams.set('state',         stateKey);
  authUrl.searchParams.set('prompt',        'select_account');
  res.redirect(authUrl.toString());
});

router.get('/auth/google/callback', authRateLimiter, async (req, res) => {
  const { code, state: stateKey, error } = req.query;
  if (error || typeof code !== 'string' || typeof stateKey !== 'string') return res.redirect(consoleRedirect('error'));
  const stateData = oauthStates.get(stateKey);
  if (!stateData || stateData.provider !== 'google' || Date.now() - stateData.created > 600_000 || !constantTimeEqual(parseCookies(req.headers.cookie)[oauthStateCookieName('google')], stateKey)) return res.redirect(consoleRedirect('invalid_state'));
  await roleAssignmentsReady.catch(() => {}); 
  oauthStates.delete(stateKey);
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET, redirect_uri: stateData.callbackUrl, grant_type: 'authorization_code' }),
      signal: AbortSignal.timeout(8_000),
    });
    const tokens = await tokenRes.json();
    if (!tokenRes.ok || !tokens.access_token) throw new Error('Google OAuth token exchange failed');
    const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', { headers: { Authorization: `Bearer ${tokens.access_token}` }, signal: AbortSignal.timeout(8_000) });
    const user    = await userRes.json();
    if (!userRes.ok || !user.email || user.verified_email !== true) return res.redirect(consoleRedirect('denied'));
    const identity = { provider: 'google', id: String(user.id || ''), email: user.email.trim().toLowerCase(), name: String(user.name || ''), picture: typeof user.picture === 'string' ? user.picture : null };
    if (!isIdentityAuthorized(identity)) return res.redirect(consoleRedirect('denied'));
    const sessionToken = issueSession(identity);
    res.setHeader('Set-Cookie', [serializeSessionCookie(sessionToken, req), expireOAuthStateCookie('google')]);
    res.redirect(consoleRedirect('success'));
  } catch (err) { logger.error('Google OAuth callback error', err); res.redirect(consoleRedirect('error')); }
});

router.get('/auth/discord', authRateLimiter, (req, res) => {
  if (!DISCORD_CLIENT_ID || !DISCORD_CLIENT_SECRET || !DISCORD_CALLBACK_URL) {
    return res.status(503).send('Discord OAuth is not fully configured. Set DISCORD_OAUTH_CLIENT_ID, DISCORD_OAUTH_CLIENT_SECRET, and DISCORD_OAUTH_CALLBACK_URL.');
  }
  if (!consumeCaptchaTicket(req, 'discord')) return res.redirect(consoleRedirect('captcha_required'));
  if (RECAPTCHA_REQUIRED) res.append('Set-Cookie', expireCaptchaCookie());
  const stateKey = createOAuthState('discord', DISCORD_CALLBACK_URL);
  res.append('Set-Cookie', serializeOAuthStateCookie('discord', stateKey));
  const authUrl = new URL('https://discord.com/oauth2/authorize');
  authUrl.searchParams.set('client_id', DISCORD_CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', DISCORD_CALLBACK_URL);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', 'identify email');
  authUrl.searchParams.set('state', stateKey);
  authUrl.searchParams.set('prompt', 'consent');
  res.redirect(authUrl.toString());
});

router.get('/auth/discord/callback', authRateLimiter, async (req, res) => {
  const { code, state: stateKey, error } = req.query;
  if (error || typeof code !== 'string' || typeof stateKey !== 'string') return res.redirect(consoleRedirect('error'));
  const stateData = oauthStates.get(stateKey);
  if (!stateData || stateData.provider !== 'discord' || Date.now() - stateData.created > 600_000 || !constantTimeEqual(parseCookies(req.headers.cookie)[oauthStateCookieName('discord')], stateKey)) return res.redirect(consoleRedirect('invalid_state'));
  await roleAssignmentsReady.catch(() => {});
  oauthStates.delete(stateKey);
  try {
    const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: DISCORD_CLIENT_ID,
        client_secret: DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: stateData.callbackUrl,
      }),
      signal: AbortSignal.timeout(8_000),
    });
    const tokens = await tokenResponse.json();
    if (!tokenResponse.ok || typeof tokens.access_token !== 'string') throw new Error('Discord OAuth token exchange failed');
    const userResponse = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
      signal: AbortSignal.timeout(8_000),
    });
    const user = await userResponse.json();
    if (!userResponse.ok || typeof user.id !== 'string' || !/^\d{17,20}$/.test(user.id)) return res.redirect(consoleRedirect('denied'));
    const email = user.verified === true && typeof user.email === 'string' ? user.email.trim().toLowerCase() : '';
    const identity = {
      provider: 'discord', id: user.id, discordId: user.id, email,
      name: typeof user.global_name === 'string' ? user.global_name : String(user.username || 'Discord user'),
      picture: typeof user.avatar === 'string' ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=256` : null,
    };
    if (!isIdentityAuthorized(identity)) return res.redirect(consoleRedirect('denied'));
    const sessionToken = issueSession(identity);
    res.setHeader('Set-Cookie', [serializeSessionCookie(sessionToken, req), expireOAuthStateCookie('discord')]);
    res.redirect(consoleRedirect('success'));
  } catch (err) {
    logger.error('Discord OAuth callback error', err);
    res.redirect(consoleRedirect('error'));
  }
});

router.get('/auth/me', authenticate, (req, res) => {
  // Fix #2: Never echo the session token back — return only safe user fields
  const { email, name, picture, provider, id, discordId } = req.sessionUser;
  res.json({ success: true, user: { email: email || null, name: name || null, picture: picture || null, provider, id: id || discordId || null }, csrfToken: req.sessionUser.csrfToken });
});

router.post('/auth/logout', authenticate, requireCsrf, (req, res) => {
  const tok = getSessionToken(req);
  if (tok) sessions.delete(tok);
  res.setHeader('Set-Cookie', expireSessionCookies());
  res.json({ success: true });
});

router.use('/api', apiCors, authenticate, authorizeApiRequest, apiRateLimiter, requireCsrf, auditApiRequest);

router.get('/api/auth/permissions', authenticate, (req, res) => {
  const role = getBestRoleAssignment(req.sessionUser);
  const guildIds = getAccessibleGuildIds(req.sessionUser);
  res.json({ success: true, authenticated: true, role: role?.role || null, level: role?.level || null, scope: role?.scope || null, isOwner: Boolean(role?.role === 'owner'), guildIds, hierarchy: describeRoleHierarchy() });
});

router.get('/api/security/roles', authenticate, (_req, res) => {
  res.json({ success: true, assignments: getStaffRoleAssignments(), hierarchy: describeRoleHierarchy() });
});

router.post('/api/security/roles', authenticate, async (req, res) => {
  try {
    const owner = authorize(req.sessionUser, PERMISSIONS.OWNER_MANAGE, null);
    if (!owner.allowed) return res.status(403).json({ error: 'Owner authorization required.' });
    const grant = req.body;
    const current = getStaffRoleAssignments().filter(item => !(
      item.identityType === grant?.identityType && item.identity === grant?.identity && item.role === grant?.role
    ));
    const assignments = replaceStaffRoleAssignments([...current, grant]);
    await persistRoleAssignments(assignments, req.sessionUser.email || req.sessionUser.discordId || req.sessionUser.id || 'owner');
    res.status(201).json({ success: true, assignments });
  } catch (err) { res.status(400).json({ error: err.message || 'Invalid role assignment.' }); }
});

router.delete('/api/security/roles', authenticate, async (req, res) => {
  try {
    const owner = authorize(req.sessionUser, PERMISSIONS.OWNER_MANAGE, null);
    if (!owner.allowed) return res.status(403).json({ error: 'Owner authorization required.' });
    const { identityType, identity, role } = req.body || {};
    if (!['email', 'discordId'].includes(identityType) || typeof identity !== 'string' || !identity.trim()) return res.status(400).json({ error: 'identityType and identity are required.' });
    const normalizedIdentity = identityType === 'email' ? identity.trim().toLowerCase() : identity.trim();
    const current = getStaffRoleAssignments().filter(item => !(item.identityType === identityType && item.identity === normalizedIdentity && (!role || item.role === role)));
    const assignments = replaceStaffRoleAssignments(current);
    await persistRoleAssignments(assignments, req.sessionUser.email || req.sessionUser.discordId || req.sessionUser.id || 'owner');
    res.json({ success: true, assignments });
  } catch (err) { res.status(400).json({ error: err.message || 'Unable to update role assignment.' }); }
});

router.get('/api/stats', authenticate, async (req, res) => {
  try {
    const mem      = process.memoryUsage();
    const guilds   = client?.guilds?.cache ?? new Map();
    const disk     = getDiskUsage();
    let totalUsers = 0;
    guilds.forEach(g => { totalUsers += (g.memberCount || 0); });
    let mongoStatus = 'Unknown';
    try { await db.connectDB(); mongoStatus = 'Connected'; } catch { mongoStatus = 'Disconnected'; }
    const WS_LABELS = ['READY','CONNECTING','RECONNECTING','IDLE','NEARLY','DISCONNECTED','WAITING_FOR_GUILDS','IDENTIFYING','RESUMING'];
    res.json({
      username: client?.user?.username || 'N/A', tag: client?.user?.tag || 'N/A', id: client?.user?.id || 'N/A',
      avatarURL: client?.user?.displayAvatarURL?.({ size: 256, extension: 'png' }) || null,
      wsStatus: WS_LABELS[client?.ws?.status] || 'Unknown', serverCount: guilds.size, totalUsers,
      ping: client?.ws?.ping ?? -1, uptime: process.uptime(), nodeVersion: process.version,
      platform: `${os.platform()} ${os.arch()}`, cpuCores: os.cpus().length, cpuModel: os.cpus()[0]?.model || 'Unknown',
      ram: { heapUsed: mem.heapUsed, heapTotal: mem.heapTotal, rss: mem.rss, external: mem.external, sysFree: os.freemem(), sysTotal: os.totalmem() },
      // Flat aliases preserve the existing console's stats contract.
      heapUsed: mem.heapUsed, heapTotal: mem.heapTotal, rss: mem.rss, external: mem.external, sysFree: os.freemem(), sysTotal: os.totalmem(),
      totalHistories: safeCount(state.chatHistories), totalUsers_s: safeCount(state.userSettings),
      disk, mongoStatus,
      totalChatHistories: safeCount(state.chatHistories), totalServerSettings: safeCount(state.serverSettings),
      totalUserSettings: safeCount(state.userSettings), totalReminders: safeCount(state.reminders),
      totalBlacklisted: Object.values(state.blacklistedUsers || {}).flat().length,
      globalLockdown: state.globalLockdown || false, debugMode: state.debugMode || false,
      runtime: { activeModel: getActiveModel(), featureFlags: getRuntimeFeatureFlags() },
    });
  } catch (err) { logger.error('Request error', err); res.status(500).json({ error: 'Internal server error' }); }
});

router.get('/api/cmd/command-catalog', authenticate, (_req, res) => {
  // Return declared metadata only; never serialize runtime handlers or secrets.
  const catalog = commands.map(command => ({
    name: command.name,
    description: command.description,
    options: Array.isArray(command.options) ? command.options.map(option => ({
      name: option.name,
      description: option.description,
      type: option.type,
      required: Boolean(option.required),
      choices: Array.isArray(option.choices) ? option.choices : undefined,
      options: Array.isArray(option.options) ? option.options : undefined,
    })) : [],
  }));
  res.json({ success: true, count: catalog.length, commands: catalog });
});

router.get('/api/audit/logs', authenticate, async (req, res) => {
  try {
    const requestedLimit = Number.parseInt(String(req.query.limit ?? '50'), 10);
    const requestedOffset = Number.parseInt(String(req.query.offset ?? '0'), 10);
    if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || !Number.isInteger(requestedOffset) || requestedOffset < 0) {
      return res.status(400).json({ error: 'limit and offset must be non-negative integers (limit must be at least 1).' });
    }
    const limit = Math.min(requestedLimit, 100);
    const offset = Math.min(requestedOffset, 10000);
    const filter = {};
    if (typeof req.query.guildId === 'string' && /^\d{17,20}$/.test(req.query.guildId)) filter.guildId = req.query.guildId;
    if (typeof req.query.actor === 'string' && req.query.actor.trim()) filter.actor = req.query.actor.trim().slice(0, 320);
    if (typeof req.query.since === 'string') {
      const since = new Date(req.query.since);
      if (Number.isNaN(since.getTime())) return res.status(400).json({ error: 'since must be a valid ISO date.' });
      filter.at = { $gte: since };
    }
    await db.connectDB();
    const collection = db.getDB().collection('consoleAuditLogs');
    const [entries, total] = await Promise.all([
      collection.find(filter, { projection: { _id: 0 } }).sort({ at: -1 }).skip(offset).limit(limit).toArray(),
      collection.countDocuments(filter),
    ]);
    res.json({ success: true, entries, total, limit, offset });
  } catch (error) {
    logger.error('Audit log query failed', error);
    res.status(500).json({ error: 'Audit log query failed.' });
  }
});

router.post('/api/cmd/save-state', authenticate, async (req, res) => {
  try { await saveStateToFile(); res.json({ success: true, message: 'State saved.' }); }
  catch (err) { logger.error('Request error', err); res.status(500).json({ error: 'Internal server error' }); }
});

router.post('/api/cmd/reload-state', authenticate, async (_req, res) => {
  res.json({ success: true, message: 'Full reload requires restart.' });
});

router.post('/api/cmd/clear-history', authenticate, async (req, res) => {
  try {
    const { id } = req.body;
    if (id) {
      delete state.chatHistories[id];
      if (db.deleteChatHistory) await db.deleteChatHistory(id);
      res.json({ success: true, message: `History cleared for ${id}.` });
    } else {
      const count = safeCount(state.chatHistories);
      state.chatHistories = {};
      await saveStateToFile();
      res.json({ success: true, message: `Cleared ${count} chat histories.` });
    }
  } catch (err) { logger.error('Request error', err); res.status(500).json({ error: 'Internal server error' }); }
});

router.get('/api/cmd/chat-history/:id', authenticate, (req, res) => {
  try {
    // chatHistories[id] is { [messagesId]: [...entries] } — flatten into a single array.
    // Works for both user IDs and guild/server IDs.
    const historyObj = state.chatHistories[req.params.id];
    if (!historyObj || typeof historyObj !== 'object' || Object.keys(historyObj).length === 0) {
      return res.status(404).json({ success: false, error: 'No history found.' });
    }
    const flat = Object.values(historyObj).flat().filter(Boolean);
    flat.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    res.json({ success: true, data: flat, channels: Object.keys(historyObj).length });
  } catch (err) { logger.error('Request error', err); res.status(500).json({ error: 'Internal server error' }); }
});

router.get('/api/cmd/all-histories', authenticate, (req, res) => {
  try {
    const ids = Object.keys(state.chatHistories || {});
    const summaries = ids.map(id => ({
      id,
      messageCount: Array.isArray(state.chatHistories[id]) ? state.chatHistories[id].length : 0,
    }));
    res.json({ success: true, data: summaries, total: ids.length });
  } catch (err) { logger.error('Request error', err); res.status(500).json({ error: 'Internal server error' }); }
});

router.post('/api/cmd/blacklist', authenticate, async (req, res) => {
  try {
    const { guildId, userId } = req.body;
    if (!guildId || !userId) return res.status(400).json({ error: 'guildId and userId required.' });
    if (!state.blacklistedUsers[guildId]) state.blacklistedUsers[guildId] = [];
    if (!state.blacklistedUsers[guildId].includes(userId)) {
      state.blacklistedUsers[guildId].push(userId);
      if (db.saveBlacklistedUsers) await db.saveBlacklistedUsers(guildId, state.blacklistedUsers[guildId]);
    }
    res.json({ success: true, message: `User ${userId} blacklisted in ${guildId}.` });
  } catch (err) { logger.error('Request error', err); res.status(500).json({ error: 'Internal server error' }); }
});

router.post('/api/cmd/unblacklist', authenticate, async (req, res) => {
  try {
    const { guildId, userId } = req.body;
    if (!guildId || !userId) return res.status(400).json({ error: 'guildId and userId required.' });
    const list = state.blacklistedUsers[guildId] || [];
    state.blacklistedUsers[guildId] = list.filter(u => u !== userId);
    if (db.saveBlacklistedUsers) await db.saveBlacklistedUsers(guildId, state.blacklistedUsers[guildId]);
    res.json({ success: true, message: `User ${userId} unblacklisted.` });
  } catch (err) { logger.error('Request error', err); res.status(500).json({ error: 'Internal server error' }); }
});

router.get('/api/cmd/blacklisted-users', authenticate, (req, res) => {
  try {
    const data = state.blacklistedUsers || {};
    res.json({ success: true, data, total: Object.values(data).flat().length });
  } catch (err) { logger.error('Request error', err); res.status(500).json({ error: 'Internal server error' }); }
});

router.post('/api/cmd/switch-api-key', authenticate, (req, res) => {
  try {
    rotateToNextKey();
    const stats = getApiKeyStats();
    res.json({ success: true, message: `Switched to Key ${stats.currentKey}.`, stats });
  } catch (err) { logger.error('Request error', err); res.status(500).json({ error: 'Internal server error' }); }
});

router.post('/api/cmd/switch-to-key/:index', authenticate, (req, res) => {
  try {
    const idx   = parseInt(req.params.index, 10);
    const stats = getApiKeyStats();
    if (isNaN(idx) || idx < 1 || idx > stats.totalKeys)
      return res.status(400).json({ error: `Key index must be 1-${stats.totalKeys}.` });
    const needed = idx - stats.currentKey;
    if (needed !== 0) {
      const times = ((needed % stats.totalKeys) + stats.totalKeys) % stats.totalKeys;
      for (let i = 0; i < times; i++) rotateToNextKey();
    }
    res.json({ success: true, message: `Switched to Key ${idx}.`, stats: getApiKeyStats() });
  } catch (err) { logger.error('Request error', err); res.status(500).json({ error: 'Internal server error' }); }
});

router.get('/api/cmd/api-key-stats', authenticate, (req, res) => {
  try { res.json({ success: true, data: getApiKeyStats() }); }
  catch (err) { logger.error('Request error', err); res.status(500).json({ error: 'Internal server error' }); }
});

router.post('/api/cmd/lockdown', authenticate, (req, res) => {
  try {
    const { enabled } = req.body;
    state.globalLockdown = Boolean(enabled);
    res.json({ success: true, message: `Global lockdown ${enabled ? 'ENABLED' : 'DISABLED'}.`, enabled: state.globalLockdown });
  } catch (err) { logger.error('Request error', err); res.status(500).json({ error: 'Internal server error' }); }
});

router.post('/api/cmd/announce', authenticate, async (req, res) => {
  try {
    const { message, title = 'Announcement', embedColor = '#6D5AE6', useEmbed = true } = req.body;
    if (!message) return res.status(400).json({ error: 'message required.' });
    const { EmbedBuilder, ChannelType } = await import('discord.js');
    let sentCount = 0, failCount = 0, skipCount = 0;
    for (const [, guild] of (client?.guilds?.cache ?? new Map())) {
      try {
        const channels = guild.channels.cache.filter(c =>
          c.type === ChannelType.GuildText && c.permissionsFor(guild.members.me)?.has(['SendMessages','ViewChannel'])
        );
        const target = channels.find(c => ['general','announcements','bot','chat','main'].includes(c.name.toLowerCase())) || channels.first();
        if (!target) { skipCount++; continue; }
        if (useEmbed) {
          const embed = new EmbedBuilder().setColor(embedColor).setTitle(title).setDescription(message).setTimestamp();
          await target.send({ embeds: [embed] });
        } else { await target.send(message); }
        sentCount++;
      } catch { failCount++; }
    }
    res.json({ success: true, message: `Sent to ${sentCount} servers. Failed: ${failCount}. Skipped: ${skipCount}.` });
  } catch (err) { logger.error('Request error', err); res.status(500).json({ error: 'Internal server error' }); }
});

router.post('/api/cmd/leave-server', authenticate, async (req, res) => {
  try {
    const { guildId } = req.body;
    if (!guildId) return res.status(400).json({ error: 'guildId required.' });
    const guild = client?.guilds?.cache?.get(guildId);
    if (!guild) return res.status(404).json({ error: 'Guild not found.' });
    await guild.leave();
    res.json({ success: true, message: `Left server: ${guild.name}.` });
  } catch (err) { logger.error('Request error', err); res.status(500).json({ error: 'Internal server error' }); }
});

router.get('/api/cmd/servers', authenticate, (req, res) => {
  try {
    const servers = [];
    const accessibleGuildIds = getAccessibleGuildIds(req.sessionUser);
    for (const [, g] of (client?.guilds?.cache ?? new Map())) {
      if (accessibleGuildIds !== null && !accessibleGuildIds.includes(g.id)) continue;
      servers.push({
        id: g.id, name: g.name, memberCount: g.memberCount, iconURL: g.iconURL(),
        ownerId: g.ownerId, createdAt: g.createdAt, joinedAt: g.joinedAt,
        settings: state.serverSettings[g.id] || {}, blacklisted: (state.blacklistedUsers[g.id] || []).length,
      });
    }
    servers.sort((a,b) => b.memberCount - a.memberCount);
    res.json({ success: true, data: servers, count: servers.length });
  } catch (err) { logger.error('Request error', err); res.status(500).json({ error: 'Internal server error' }); }
});

router.post('/api/cmd/reset-server', authenticate, async (req, res) => {
  try {
    const { guildId } = req.body;
    if (!guildId) return res.status(400).json({ error: 'guildId required.' });
    delete state.serverSettings[guildId];
    if (db.saveServerSettings) await db.saveServerSettings(guildId, {});
    res.json({ success: true, message: `Server settings reset for ${guildId}.` });
  } catch (err) { logger.error('Request error', err); res.status(500).json({ error: 'Internal server error' }); }
});

router.get('/api/cmd/server-settings/:guildId', authenticate, (req, res) => {
  try {
    const settings = state.serverSettings[req.params.guildId] || {};
    res.json({ success: true, data: { ...getDefaultServerSettings(), ...settings } });
  } catch (err) { logger.error('Request error', err); res.status(500).json({ error: 'Internal server error' }); }
});

router.put('/api/cmd/server-settings/:guildId', authenticate, async (req, res) => {
  try {
    const { guildId } = req.params;
    if (!state.serverSettings[guildId]) state.serverSettings[guildId] = getDefaultServerSettings();
    Object.assign(state.serverSettings[guildId], req.body);
    if (db.saveServerSettings) await db.saveServerSettings(guildId, state.serverSettings[guildId]);
    res.json({ success: true, data: state.serverSettings[guildId] });
  } catch (err) { logger.error('Request error', err); res.status(500).json({ error: 'Internal server error' }); }
});

router.get('/api/cmd/user-settings/:userId', authenticate, (req, res) => {
  try {
    const settings = state.userSettings[req.params.userId] || {};
    res.json({ success: true, data: { ...getDefaultUserSettings(), ...settings }, found: Object.keys(settings).length > 0 });
  } catch (err) { logger.error('Request error', err); res.status(500).json({ error: 'Internal server error' }); }
});

router.put('/api/cmd/user-settings/:userId', authenticate, async (req, res) => {
  try {
    const { userId } = req.params;
    if (!state.userSettings[userId]) state.userSettings[userId] = getDefaultUserSettings();
    Object.assign(state.userSettings[userId], req.body);
    if (db.saveUserSettings) await db.saveUserSettings(userId, state.userSettings[userId]);
    res.json({ success: true, data: state.userSettings[userId] });
  } catch (err) { logger.error('Request error', err); res.status(500).json({ error: 'Internal server error' }); }
});

router.post('/api/cmd/reset-user-settings', authenticate, async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required.' });
    delete state.userSettings[userId];
    if (db.saveUserSettings) await db.saveUserSettings(userId, {});
    res.json({ success: true, message: `User settings reset for ${userId}.` });
  } catch (err) { logger.error('Request error', err); res.status(500).json({ error: 'Internal server error' }); }
});

router.post('/api/cmd/clear-image-usage', authenticate, async (req, res) => {
  try { const c = safeCount(state.imageUsage); state.imageUsage = {}; await saveStateToFile(); res.json({ success: true, message: `Cleared image usage for ${c} users.` }); }
  catch (err) { logger.error('Request error', err); res.status(500).json({ error: 'Internal server error' }); }
});

router.post('/api/cmd/clear-summary-usage', authenticate, async (req, res) => {
  try { const c = safeCount(state.summaryUsage); state.summaryUsage = {}; await saveStateToFile(); res.json({ success: true, message: `Cleared summary usage for ${c} users.` }); }
  catch (err) { logger.error('Request error', err); res.status(500).json({ error: 'Internal server error' }); }
});

router.post('/api/cmd/toggle-debug', authenticate, (req, res) => {
  try { state.debugMode = !state.debugMode; res.json({ success: true, message: `Debug mode ${state.debugMode ? 'ON' : 'OFF'}.`, enabled: state.debugMode }); }
  catch (err) { logger.error('Request error', err); res.status(500).json({ error: 'Internal server error' }); }
});

router.post('/api/cmd/set-presence', authenticate, async (req, res) => {
  try {
    const { status = 'online', activity = '', activityType = 0 } = req.body;
    const ActivityType = (await import('discord.js')).ActivityType;
    client?.user?.setPresence({ status, activities: activity ? [{ name: activity, type: activityType }] : [] });
    runtimeConfig.presence = { status, activity, activityType };
    saveRuntimeConfig();
    res.json({ success: true, message: 'Presence set.' });
  } catch (err) { logger.error('Request error', err); res.status(500).json({ error: 'Internal server error' }); }
});

router.get('/api/cmd/get-presence', authenticate, (req, res) => {
  try {
    const presence = client?.user?.presence;
    if (!presence) return res.json({ success: true, presence: null });
    res.json({ success: true, presence: { status: presence.status, activities: presence.activities?.map(a => ({ name: a.name, type: a.type })) || [] } });
  } catch (err) { logger.error('Request error', err); res.status(500).json({ error: 'Internal server error' }); }
});

router.post('/api/cmd/send-dm', authenticate, async (req, res) => {
  try {
    const { userId, message } = req.body;
    if (!userId || !message) return res.status(400).json({ error: 'userId and message required.' });
    const user = await client?.users?.fetch(userId);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    await user.send(message);
    res.json({ success: true, message: `DM sent to ${user.tag}.` });
  } catch (err) { logger.error('Request error', err); res.status(500).json({ error: 'Internal server error' }); }
});

router.post('/api/cmd/clear-quote-usage', authenticate, async (req, res) => {
  try { const c = safeCount(state.quoteUsage); state.quoteUsage = {}; await saveStateToFile(); res.json({ success: true, message: `Cleared quote usage for ${c} users.` }); }
  catch (err) { logger.error('Request error', err); res.status(500).json({ error: 'Internal server error' }); }
});

router.post('/api/cmd/restart', authenticate, async (req, res) => {
  try { await saveStateToFile(); res.json({ success: true, message: 'Restarting...' }); setTimeout(() => process.exit(0), 1500); }
  catch (err) { logger.error('Request error', err); res.status(500).json({ error: 'Internal server error' }); }
});

router.post('/api/cmd/resolve-username', authenticate, async (req, res) => {
  try {
    const { username } = req.body;
    if (!username) return res.status(400).json({ error: 'username required.' });

    // Pass 1: check in-memory cache (zero API calls, instant)
    for (const [, guild] of (client?.guilds?.cache ?? new Map())) {
      const member = guild.members.cache.find(m =>
        m.user.username?.toLowerCase() === username.toLowerCase() ||
        m.user.tag?.toLowerCase()      === username.toLowerCase()
      );
      if (member) return res.json({ success: true, id: member.user.id, tag: member.user.tag });
    }

    // Pass 2: query Discord's search API per guild (handles uncached members)
    for (const [, guild] of (client?.guilds?.cache ?? new Map())) {
      try {
        const results = await guild.members.search({ query: username, limit: 5 });
        const member = results.find(m =>
          m.user.username?.toLowerCase() === username.toLowerCase() ||
          m.user.tag?.toLowerCase()      === username.toLowerCase()
        );
        if (member) return res.json({ success: true, id: member.user.id, tag: member.user.tag });
      } catch { /* guild may not support search – continue */ }
    }

    res.status(404).json({ success: false, error: 'User not found in any guild.' });
  } catch (err) { logger.error('Request error', err); res.status(500).json({ error: 'Internal server error' }); }
});

router.get('/api/cmd/user-profile/:userId', authenticate, async (req, res) => {
  try {
    const { userId } = req.params;
    const user = await client?.users?.fetch(userId, { force: true }).catch(() => null);
    if (!user) return res.status(404).json({ success: false, error: 'User not found.' });
    let mutualGuilds = 0;
    for (const [, guild] of (client?.guilds?.cache ?? new Map())) { if (guild.members.cache.has(userId)) mutualGuilds++; }
    res.json({
      success: true,
      user: {
        id: user.id, username: user.username, displayName: user.displayName || user.globalName || user.username,
        tag: user.tag, avatarURL: user.displayAvatarURL({ size: 128, extension: 'png' }),
        bot: user.bot, system: user.system, createdAt: user.createdAt?.toISOString(),
        mutualGuilds, hasSettings: !!(state.userSettings?.[userId] && Object.keys(state.userSettings[userId]).length),
        hasHistory: !!(state.chatHistories?.[userId]),
        blacklistedGuilds: Object.entries(state.blacklistedUsers || {}).filter(([,v]) => v.includes(userId)).map(([k]) => k),
      }
    });
  } catch (err) { logger.error('Request error', err); res.status(500).json({ error: 'Internal server error' }); }
});

router.get('/api/config/activities', authenticate, (req, res) => {
  try {
    const content = fs.readFileSync(BASE_CONFIG_PATH, 'utf8');
    const match = content.match(/activities\s*:\s*\[([\s\S]*?)\]/);
    const activities = [];
    if (match) {
      const entries = match[1].matchAll(/\{\s*name\s*:\s*["'`]([^"'`]+)["'`]\s*,\s*type\s*:\s*["'`]([^"'`]+)["'`]\s*\}/g);
      for (const e of entries) activities.push({ name: e[1], type: e[2] });
    }
    res.json({ success: true, data: activities });
  } catch (err) { logger.error('Request error', err); res.status(500).json({ error: 'Internal server error' }); }
});

router.get('/api/cmd/guild-info/:guildId', authenticate, async (req, res) => {
  try {
    const guild = client?.guilds?.cache?.get(req.params.guildId);
    if (!guild) return res.status(404).json({ success: false, error: 'Guild not found.' });
    res.json({
      success: true,
      guild: {
        id: guild.id, name: guild.name, ownerId: guild.ownerId, memberCount: guild.memberCount,
        iconURL: guild.iconURL(), createdAt: guild.createdAt?.toLocaleDateString(),
        premiumSubscriptionCount: guild.premiumSubscriptionCount || 0, description: guild.description || null,
      }
    });
  } catch (err) { logger.error('Request error', err); res.status(500).json({ error: 'Internal server error' }); }
});

router.post('/api/cmd/clear-reminders', authenticate, async (req, res) => {
  try { const count = safeCount(state.reminders); state.reminders = {}; await saveStateToFile(); res.json({ success: true, message: `Cleared ${count} reminder(s).` }); }
  catch (err) { logger.error('Request error', err); res.status(500).json({ error: 'Internal server error' }); }
});

router.get('/api/cmd/reminders', authenticate, (req, res) => {
  try { res.json({ success: true, data: state.reminders || {}, total: safeCount(state.reminders) }); }
  catch (err) { logger.error('Request error', err); res.status(500).json({ error: 'Internal server error' }); }
});

router.post('/api/cmd/clear-birthdays', authenticate, async (req, res) => {
  try { const count = safeCount(state.birthdays); state.birthdays = {}; await saveStateToFile(); res.json({ success: true, message: `Cleared ${count} birthday(s).` }); }
  catch (err) { logger.error('Request error', err); res.status(500).json({ error: 'Internal server error' }); }
});

router.get('/api/cmd/birthdays', authenticate, (req, res) => {
  try { res.json({ success: true, data: state.birthdays || {}, total: safeCount(state.birthdays) }); }
  catch (err) { logger.error('Request error', err); res.status(500).json({ error: 'Internal server error' }); }
});

router.post('/api/cmd/clear-starter-usage', authenticate, async (req, res) => {
  try { const count = safeCount(state.starterUsage); state.starterUsage = {}; await saveStateToFile(); res.json({ success: true, message: `Cleared starter usage for ${count} users.` }); }
  catch (err) { logger.error('Request error', err); res.status(500).json({ error: 'Internal server error' }); }
});

router.post('/api/cmd/clear-compliment-usage', authenticate, async (req, res) => {
  try { const count = safeCount(state.complimentUsage); state.complimentUsage = {}; await saveStateToFile(); res.json({ success: true, message: `Cleared compliment usage for ${count} users.` }); }
  catch (err) { logger.error('Request error', err); res.status(500).json({ error: 'Internal server error' }); }
});

router.post('/api/cmd/dm-all-owners', authenticate, async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'message required.' });
    let sent = 0, failed = 0;
    const seenOwners = new Set();
    for (const [, guild] of (client?.guilds?.cache ?? new Map())) {
      if (seenOwners.has(guild.ownerId)) continue;
      seenOwners.add(guild.ownerId);
      try { const owner = await client.users.fetch(guild.ownerId); await owner.send(message); sent++; } catch { failed++; }
    }
    res.json({ success: true, message: `DM sent to ${sent} owners. Failed: ${failed}.` });
  } catch (err) { logger.error('Request error', err); res.status(500).json({ error: 'Internal server error' }); }
});

router.post('/api/cmd/reload-commands', authenticate, async (req, res) => {
  try {
    const { REST, Routes } = await import('discord.js');
    const token   = process.env.DISCORD_BOT_TOKEN || '';
    if (!token) return res.status(503).json({ error: 'DISCORD_BOT_TOKEN is not configured.' });
    const rest    = new REST().setToken(token);
    const cmdModule = await import('../commands.js');
    const cmds    = cmdModule.commands || cmdModule.default || [];
    await rest.put(Routes.applicationCommands(client.user.id), { body: cmds });
    res.json({ success: true, message: 'Slash commands reloaded.' });
  } catch (err) { logger.error('Request error', err); res.status(500).json({ error: 'Internal server error' }); }
});

router.post('/api/cmd/purge-blacklist', authenticate, async (req, res) => {
  try {
    const total = Object.values(state.blacklistedUsers || {}).flat().length;
    state.blacklistedUsers = {}; await saveStateToFile();
    res.json({ success: true, message: `Purged ${total} blacklist entries.` });
  } catch (err) { logger.error('Request error', err); res.status(500).json({ error: 'Internal server error' }); }
});

router.post('/api/cmd/announce-users', authenticate, async (req, res) => {
  try {
    const { message, title = 'Announcement', embedColor = '#6D5AE6', useEmbed = true } = req.body;
    if (!message) return res.status(400).json({ error: 'message required.' });
    const { EmbedBuilder } = await import('discord.js');
    const seen = new Set(); let sent = 0, failed = 0;
    for (const [, guild] of (client?.guilds?.cache ?? new Map())) {
      for (const [uid, member] of guild.members.cache) {
        if (member.user.bot || seen.has(uid)) continue;
        seen.add(uid);
        try {
          if (useEmbed) {
            const embed = new EmbedBuilder().setColor(embedColor).setTitle(title).setDescription(message).setTimestamp();
            await member.user.send({ embeds: [embed] });
          } else { await member.user.send(message); }
          sent++;
        } catch { failed++; }
      }
    }
    res.json({ success: true, message: `DM sent to ${sent} users. Failed: ${failed}.` });
  } catch (err) { logger.error('Request error', err); res.status(500).json({ error: 'Internal server error' }); }
});

router.get('/api/cmd/channels/:guildId', authenticate, async (req, res) => {
  try {
    const { ChannelType } = await import('discord.js');
    const guild = client?.guilds?.cache?.get(req.params.guildId);
    if (!guild) return res.status(404).json({ error: 'Guild not found.' });
    const channels = guild.channels.cache
      .filter(c => c.type === ChannelType.GuildText || c.type === ChannelType.GuildVoice)
      .map(c => ({ id: c.id, name: c.name, type: c.type, position: c.position, parentId: c.parentId }))
      .sort((a,b) => a.position - b.position);
    res.json({ success: true, data: channels, count: channels.length });
  } catch (err) { logger.error('Request error', err); res.status(500).json({ error: 'Internal server error' }); }
});

router.get('/api/cmd/members/:guildId', authenticate, async (req, res) => {
  try {
    const guild = client?.guilds?.cache?.get(req.params.guildId);
    if (!guild) return res.status(404).json({ error: 'Guild not found.' });
    const members = guild.members.cache.map(m => ({
      id: m.user.id, username: m.user.username, displayName: m.displayName,
      bot: m.user.bot, joinedAt: m.joinedAt?.toISOString(),
      roles: m.roles.cache.map(r => r.name).filter(n => n !== '@everyone'),
    }));
    res.json({ success: true, data: members, count: members.length });
  } catch (err) { logger.error('Request error', err); res.status(500).json({ error: 'Internal server error' }); }
});

router.post('/api/cmd/send-channel', authenticate, async (req, res) => {
  try {
    const { channelId, message, embed } = req.body;
    if (!channelId || !message) return res.status(400).json({ error: 'channelId and message required.' });
    const channel = client?.channels?.cache?.get(channelId) || await client?.channels?.fetch(channelId).catch(() => null);
    if (!channel) return res.status(404).json({ error: 'Channel not found.' });
    if (embed) {
      const { EmbedBuilder } = await import('discord.js');
      const e = new EmbedBuilder().setDescription(message);
      if (embed.title) e.setTitle(embed.title);
      if (embed.color) e.setColor(embed.color);
      await channel.send({ embeds: [e] });
    } else { await channel.send(message); }
    res.json({ success: true, message: `Message sent to #${channel.name}.` });
  } catch (err) { logger.error('Request error', err); res.status(500).json({ error: 'Internal server error' }); }
});

router.post('/api/cmd/kick-member', authenticate, async (req, res) => {
  try {
    const { guildId, userId, reason = 'Admin action via dashboard' } = req.body;
    if (!guildId || !userId) return res.status(400).json({ error: 'guildId and userId required.' });
    const guild  = client?.guilds?.cache?.get(guildId);
    if (!guild) return res.status(404).json({ error: 'Guild not found.' });
    const member = guild.members.cache.get(userId) || await guild.members.fetch(userId).catch(() => null);
    if (!member) return res.status(404).json({ error: 'Member not found.' });
    await member.kick(reason);
    res.json({ success: true, message: `Kicked ${member.user.tag} from ${guild.name}.` });
  } catch (err) { logger.error('Request error', err); res.status(500).json({ error: 'Internal server error' }); }
});

router.post('/api/cmd/ban-member', authenticate, async (req, res) => {
  try {
    const { guildId, userId, reason = 'Admin action via dashboard', deleteMessageDays = 0 } = req.body;
    if (!guildId || !userId) return res.status(400).json({ error: 'guildId and userId required.' });
    const guild = client?.guilds?.cache?.get(guildId);
    if (!guild) return res.status(404).json({ error: 'Guild not found.' });
    await guild.bans.create(userId, { reason, deleteMessageSeconds: deleteMessageDays * 86400 });
    res.json({ success: true, message: `Banned user ${userId} from ${guild.name}.` });
  } catch (err) { logger.error('Request error', err); res.status(500).json({ error: 'Internal server error' }); }
});

router.post('/api/cmd/set-nickname', authenticate, async (req, res) => {
  try {
    const { guildId, nickname } = req.body;
    if (!guildId) return res.status(400).json({ error: 'guildId required.' });
    const guild = client?.guilds?.cache?.get(guildId);
    if (!guild) return res.status(404).json({ error: 'Guild not found.' });
    await guild.members.me.setNickname(nickname || null);
    res.json({ success: true, message: `Nickname set in ${guild.name}.` });
  } catch (err) { logger.error('Request error', err); res.status(500).json({ error: 'Internal server error' }); }
});

router.get('/api/cmd/invite-link', authenticate, (req, res) => {
  try {
    const id = client?.user?.id;
    if (!id) return res.status(500).json({ error: 'Bot not ready.' });
    const link = createBotInviteLink(id);
    res.json({ success: true, link });
  } catch (err) { logger.error('Request error', err); res.status(500).json({ error: 'Internal server error' }); }
});

router.get('/api/cmd/state-snapshot', authenticate, (req, res) => {
  try {
    res.json({
      success: true,
      data: {
        chatHistoriesCount: safeCount(state.chatHistories), serverSettingsCount: safeCount(state.serverSettings),
        userSettingsCount: safeCount(state.userSettings), remindersCount: safeCount(state.reminders),
        birthdaysCount: safeCount(state.birthdays), blacklistedCount: Object.values(state.blacklistedUsers || {}).flat().length,
        imageUsageCount: safeCount(state.imageUsage), summaryUsageCount: safeCount(state.summaryUsage),
        globalLockdown: state.globalLockdown, debugMode: state.debugMode,
      }
    });
  } catch (err) { logger.error('Request error', err); res.status(500).json({ error: 'Internal server error' }); }
});

router.post('/api/cmd/clear-all-usage', authenticate, async (req, res) => {
  try {
    state.imageUsage = {}; state.summaryUsage = {}; state.quoteUsage = {};
    state.starterUsage = {}; state.complimentUsage = {};
    await saveStateToFile();
    res.json({ success: true, message: 'All usage counters cleared.' });
  } catch (err) { logger.error('Request error', err); res.status(500).json({ error: 'Internal server error' }); }
});

router.get('/api/cmd/models', authenticate, (_req, res) => {
  res.json({
    success: true,
    models: MODELS,
    registry: MODEL_REGISTRY,
    supportedModelIds: SUPPORTED_MODEL_IDS,
    defaultModel: DEFAULT_MODEL,
    effectiveModel: getActiveModel() || DEFAULT_MODEL,
    fallbackChain: MODEL_FALLBACK_CHAIN,
    enableGemma: ENABLE_GEMMA,
    gemmaDefault: GEMMA_DEFAULT_MODEL,
    runtimeOverride: getActiveModel(),
  });
});

router.post('/api/cmd/set-model', authenticate, (req, res) => {
  try {
    const requested = req.body?.model;
    if (typeof requested !== 'string' || !requested.trim()) return res.status(400).json({ error: 'model must be a registered model ID or alias.' });
    const model = MODELS[requested] || requested;
    const resolved = setRuntimeModel(model, SUPPORTED_MODEL_IDS);
    runtimeConfig.activeModel = resolved;
    saveRuntimeConfig();
    res.json({ success: true, message: `Runtime model set to ${resolved}.`, model: resolved });
  } catch (err) {
    if (err.code === 'INVALID_MODEL') return res.status(400).json({ error: err.message, supportedModelIds: SUPPORTED_MODEL_IDS });
    logger.error('Model selection failed', err);
    res.status(500).json({ error: 'Unable to update model selection.' });
  }
});

router.get('/api/config/runtime', authenticate, (_req, res) => {
  const settings = getRuntimeSettings();
  const { _keyStats, ...safeConfig } = runtimeConfig;
  res.json({ success: true, data: { ...safeConfig, ...settings } });
});

router.put('/api/config/runtime', authenticate, (req, res) => {
  try {
    const body = req.body || {};
    const allowed = ['activeModel', 'systemPrompt', 'defaultPersonality', 'safetyThresholds', 'featureFlags'];
    const unknown = Object.keys(body).filter(key => !allowed.includes(key));
    if (unknown.length) return res.status(400).json({ error: 'Unknown or non-editable runtime settings.', fields: unknown });
    if (Object.hasOwn(body, 'activeModel')) setRuntimeModel(body.activeModel, SUPPORTED_MODEL_IDS);
    if (Object.hasOwn(body, 'systemPrompt') || Object.hasOwn(body, 'defaultPersonality')) {
      setPromptOverrides({ systemPrompt: body.systemPrompt, defaultPersonality: body.defaultPersonality });
    }
    if (Object.hasOwn(body, 'safetyThresholds')) setSafetyThresholdOverrides(body.safetyThresholds);
    if (Object.hasOwn(body, 'featureFlags')) setRuntimeFeatureFlags(body.featureFlags);
    Object.assign(runtimeConfig, getRuntimeSettings());
    saveRuntimeConfig();
    res.json({ success: true, data: getRuntimeSettings() });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Invalid runtime configuration.' });
  }
});

router.delete('/api/config/runtime', authenticate, (_req, res) => {
  try {
    setRuntimeModel(null, SUPPORTED_MODEL_IDS);
    setPromptOverrides({ systemPrompt: null, defaultPersonality: null });
    setSafetyThresholdOverrides({ harassment: null, hateSpeech: null, sexualContent: null, dangerousContent: null, civicIntegrity: null });
    resetRuntimeFeatureFlags();
    runtimeConfig.activeModel = null;
    runtimeConfig.systemPrompt = null;
    runtimeConfig.defaultPersonality = null;
    runtimeConfig.safetyThresholds = {};
    runtimeConfig.featureFlags = getRuntimeFeatureFlags();
    saveRuntimeConfig();
    res.json({ success: true, message: 'Runtime overrides reset to validated defaults.', data: getRuntimeSettings() });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.get('/api/ai/config', authenticate, (_req, res) => {
  res.json({ success: true, models: MODEL_REGISTRY, settings: getRuntimeSettings(), safetyCategories: Object.keys(getRuntimeSettings().safetyThresholds) });
});

router.put('/api/ai/config/prompts', authenticate, (req, res) => {
  const access = authorize(req.sessionUser, PERMISSIONS.OWNER_MANAGE, null);
  if (!access.allowed) return res.status(403).json({ error: 'Owner authorization required.' });
  try {
    setPromptOverrides({ systemPrompt: req.body?.systemPrompt, defaultPersonality: req.body?.defaultPersonality });
    Object.assign(runtimeConfig, getRuntimeSettings());
    saveRuntimeConfig();
    res.json({ success: true, settings: getRuntimeSettings() });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.put('/api/ai/config/safety', authenticate, (req, res) => {
  const access = authorize(req.sessionUser, PERMISSIONS.OWNER_MANAGE, null);
  if (!access.allowed) return res.status(403).json({ error: 'Owner authorization required.' });
  try {
    setSafetyThresholdOverrides(req.body?.safetyThresholds || {});
    Object.assign(runtimeConfig, getRuntimeSettings());
    saveRuntimeConfig();
    res.json({ success: true, settings: getRuntimeSettings() });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.get('/api/cmd/attachment-grants/:userId', authenticate, (req, res) => {
  const access = authorize(req.sessionUser, PERMISSIONS.OWNER_MANAGE, null);
  if (!access.allowed) return res.status(403).json({ error: 'Owner authorization required.' });
  const userId = String(req.params.userId);
  res.json({ success: true, userId, attachmentProcessingEnabled: state.userSettings?.[userId]?.attachmentProcessingEnabled === true });
});

router.put('/api/cmd/attachment-grants/:userId', authenticate, async (req, res) => {
  const access = authorize(req.sessionUser, PERMISSIONS.OWNER_MANAGE, null);
  if (!access.allowed) return res.status(403).json({ error: 'Owner authorization required.' });
  const userId = String(req.params.userId);
  if (!/^\d{17,20}$/.test(userId)) return res.status(400).json({ error: 'userId must be a Discord snowflake.' });
  if (typeof req.body?.enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be a boolean.' });
  state.userSettings ||= {};
  state.userSettings[userId] ||= getDefaultUserSettings();
  state.userSettings[userId].attachmentProcessingEnabled = req.body.enabled;
  try {
    if (typeof db.saveUserSettings === 'function') await db.saveUserSettings(userId, state.userSettings[userId]);
    await saveStateToFile();
    res.json({ success: true, userId, attachmentProcessingEnabled: req.body.enabled });
  } catch (err) {
    logger.error('Failed to persist attachment grant', err);
    res.status(500).json({ error: 'Grant was changed in memory but persistence failed; retry after checking storage.' });
  }
});

router.get('/api/config/modules', authenticate, (req, res) => {
  try {
    const content = fs.readFileSync(MODULES_CONFIG_PATH, 'utf8');
    res.json({ success: true, content, path: MODULES_CONFIG_PATH });
  } catch (err) { logger.error('Request error', err); res.status(500).json({ error: 'Internal server error' }); }
});

router.put('/api/config/modules', authenticate, (req, res) => {
  if (process.env.HELIUM_ENABLE_FILE_EDITOR !== 'true') return res.status(403).json({ error: 'Source-code editing is disabled. Set HELIUM_ENABLE_FILE_EDITOR=true only for a trusted, private deployment.' });
  try {
    const { content } = req.body;
    if (typeof content !== 'string') return res.status(400).json({ error: 'content string required.' });
    fs.copyFileSync(MODULES_CONFIG_PATH, MODULES_CONFIG_PATH + '.bak');
    fs.writeFileSync(MODULES_CONFIG_PATH, content, 'utf8');
    res.json({ success: true, message: 'modules/config.js updated. Restart to apply.' });
  } catch (err) { logger.error('Request error', err); res.status(500).json({ error: 'Internal server error' }); }
});

router.post('/api/config/modules/reset', authenticate, (req, res) => {
  if (process.env.HELIUM_ENABLE_FILE_EDITOR !== 'true') return res.status(403).json({ error: 'Source-code editing is disabled. Set HELIUM_ENABLE_FILE_EDITOR=true only for a trusted, private deployment.' });
  try {
    const bak = MODULES_CONFIG_PATH + '.bak';
    if (!fs.existsSync(bak)) return res.status(404).json({ error: 'No backup found.' });
    fs.writeFileSync(MODULES_CONFIG_PATH, fs.readFileSync(bak, 'utf8'), 'utf8');
    res.json({ success: true, message: 'modules/config.js restored from backup.' });
  } catch (err) { logger.error('Request error', err); res.status(500).json({ error: 'Internal server error' }); }
});

router.get('/api/config/base', authenticate, (req, res) => {
  try {
    const content = fs.readFileSync(BASE_CONFIG_PATH, 'utf8');
    res.json({ success: true, content, path: BASE_CONFIG_PATH });
  } catch (err) { logger.error('Request error', err); res.status(500).json({ error: 'Internal server error' }); }
});

router.put('/api/config/base', authenticate, (req, res) => {
  if (process.env.HELIUM_ENABLE_FILE_EDITOR !== 'true') return res.status(403).json({ error: 'Source-code editing is disabled. Set HELIUM_ENABLE_FILE_EDITOR=true only for a trusted, private deployment.' });
  try {
    const { content } = req.body;
    if (typeof content !== 'string') return res.status(400).json({ error: 'content string required.' });
    fs.copyFileSync(BASE_CONFIG_PATH, BASE_CONFIG_PATH + '.bak');
    fs.writeFileSync(BASE_CONFIG_PATH, content, 'utf8');
    res.json({ success: true, message: 'config.js updated. Restart to apply.' });
  } catch (err) { logger.error('Request error', err); res.status(500).json({ error: 'Internal server error' }); }
});

router.post('/api/config/base/reset', authenticate, (req, res) => {
  if (process.env.HELIUM_ENABLE_FILE_EDITOR !== 'true') return res.status(403).json({ error: 'Source-code editing is disabled. Set HELIUM_ENABLE_FILE_EDITOR=true only for a trusted, private deployment.' });
  try {
    const bak = BASE_CONFIG_PATH + '.bak';
    if (!fs.existsSync(bak)) return res.status(404).json({ error: 'No backup found.' });
    fs.writeFileSync(BASE_CONFIG_PATH, fs.readFileSync(bak, 'utf8'), 'utf8');
    res.json({ success: true, message: 'config.js restored from backup.' });
  } catch (err) { logger.error('Request error', err); res.status(500).json({ error: 'Internal server error' }); }
});

router.get('/api/db/collections', authenticate, async (req, res) => {
  try {
    await db.connectDB();
    let conn; try { conn = db.getDB ? db.getDB() : null; } catch { conn = null; }
    if (!conn) return res.status(503).json({ error: 'DB not connected.' });
    const collections = await conn.listCollections().toArray();
    const result = await Promise.all(collections.map(async c => {
      const count = await conn.collection(c.name).countDocuments().catch(() => 0);
      return { name: c.name, count };
    }));
    res.json({ success: true, data: result });
  } catch (err) { logger.error('Request error', err); res.status(500).json({ error: 'Internal server error' }); }
});

router.get('/api/db/collection/:name', authenticate, async (req, res) => {
  try {
    await db.connectDB();
    let conn; try { conn = db.getDB ? db.getDB() : null; } catch { conn = null; }
    if (!conn) return res.status(503).json({ error: 'DB not available.' });
    const { page = 1, limit = 50 } = req.query;
    // Fix #7: Cap limit at 200 to prevent unbounded collection dumps
    const safeLimit = Math.min(Math.max(1, parseInt(limit) || 50), 200);
    const skip  = (parseInt(page) - 1) * safeLimit;
    const total = await conn.collection(req.params.name).countDocuments();
    const docs  = await conn.collection(req.params.name).find({}).skip(skip).limit(safeLimit).toArray();
    res.json({ success: true, data: docs, total, page: parseInt(page), limit: safeLimit });
  } catch (err) { logger.error('Request error', err); res.status(500).json({ error: 'Internal server error' }); }
});

router.put('/api/db/collection/:name/:id', authenticate, async (req, res) => {
  try {
    await db.connectDB();
    let conn; try { conn = db.getDB ? db.getDB() : null; } catch { conn = null; }
    if (!conn) return res.status(503).json({ error: 'DB not available.' });
    const { ObjectId } = await import('mongodb');
    const filter = ObjectId.isValid(req.params.id) ? { _id: new ObjectId(req.params.id) } : { _id: req.params.id };
    const result = await conn.collection(req.params.name).replaceOne(filter, req.body, { upsert: false });
    res.json({ success: true, modified: result.modifiedCount });
  } catch (err) { logger.error('Request error', err); res.status(500).json({ error: 'Internal server error' }); }
});

router.delete('/api/db/collection/:name/:id', authenticate, async (req, res) => {
  try {
    await db.connectDB();
    let conn; try { conn = db.getDB ? db.getDB() : null; } catch { conn = null; }
    if (!conn) return res.status(503).json({ error: 'DB not available.' });
    const { ObjectId } = await import('mongodb');
    const filter = ObjectId.isValid(req.params.id) ? { _id: new ObjectId(req.params.id) } : { _id: req.params.id };
    const result = await conn.collection(req.params.name).deleteOne(filter);
    res.json({ success: true, deleted: result.deletedCount });
  } catch (err) { logger.error('Request error', err); res.status(500).json({ error: 'Internal server error' }); }
});

router.get('/api/files', authenticate, (req, res) => {
  try {
    const reqPath  = req.query.path || '';
    const safePath = resolveContainedPath(ROOT_DIR, reqPath);
    const relativePath = path.relative(ROOT_DIR, safePath);
    if (relativePath.split(path.sep).some(part => part.startsWith('.') || part === 'node_modules' || part === 'uploads')) return res.status(403).json({ error: 'Sensitive paths are not exposed through the file API.' });
    if (!fs.existsSync(safePath)) return res.status(404).json({ error: 'Path not found.' });
    const stat = fs.statSync(safePath);
    if (stat.isDirectory()) {
      const entries = fs.readdirSync(safePath).filter(name => !name.startsWith('.') && name !== 'node_modules' && name !== 'uploads').map(name => {
        const fp = path.join(safePath, name);
        const s  = fs.statSync(fp);
        return { name, type: s.isDirectory() ? 'dir' : 'file', size: s.size, mtime: s.mtime, path: path.relative(ROOT_DIR, fp) };
      });
      res.json({ success: true, type: 'dir', entries, currentPath: path.relative(ROOT_DIR, safePath) });
    } else {
      if (stat.size > 2 * 1024 * 1024) return res.status(413).json({ error: 'File is larger than the 2 MiB editor limit.' });
      const content = fs.readFileSync(safePath, 'utf8');
      res.json({ success: true, type: 'file', content, path: path.relative(ROOT_DIR, safePath), size: stat.size, mtime: stat.mtime });
    }
  } catch (err) { logger.error('Request error', err); res.status(500).json({ error: 'Internal server error' }); }
});

router.put('/api/files', authenticate, (req, res) => {
  try {
    const { filePath, content } = req.body;
    if (!filePath || content === undefined) return res.status(400).json({ error: 'filePath and content required.' });
    if (process.env.HELIUM_ENABLE_FILE_EDITOR !== 'true') return res.status(403).json({ error: 'File editing is disabled. Set HELIUM_ENABLE_FILE_EDITOR=true only for a trusted deployment.' });
    const safePath = resolveContainedPath(ROOT_DIR, filePath);
    const relativePath = path.relative(ROOT_DIR, safePath);
    if (!relativePath || relativePath.split(path.sep).some(part => part.startsWith('.') || part === 'node_modules' || part === 'uploads')) return res.status(403).json({ error: 'Sensitive paths are not editable.' });
    if (fs.existsSync(safePath)) fs.copyFileSync(safePath, safePath + '.bak');
    fs.mkdirSync(path.dirname(safePath), { recursive: true });
    fs.writeFileSync(safePath, content, 'utf8');
    res.json({ success: true, message: `Saved: ${filePath}` });
  } catch (err) { logger.error('Request error', err); res.status(500).json({ error: 'Internal server error' }); }
});

router.delete('/api/files', authenticate, (req, res) => {
  try {
    const { filePath } = req.body;
    if (!filePath) return res.status(400).json({ error: 'filePath required.' });
    if (process.env.HELIUM_ENABLE_FILE_EDITOR !== 'true') return res.status(403).json({ error: 'File editing is disabled. Set HELIUM_ENABLE_FILE_EDITOR=true only for a trusted deployment.' });
    const safePath = resolveContainedPath(ROOT_DIR, filePath);
    const relativePath = path.relative(ROOT_DIR, safePath);
    if (!relativePath || relativePath.split(path.sep).some(part => part.startsWith('.') || part === 'node_modules' || part === 'uploads')) return res.status(403).json({ error: 'Sensitive paths are not editable.' });
    if (!fs.existsSync(safePath)) return res.status(404).json({ error: 'File not found.' });
    fs.unlinkSync(safePath);
    res.json({ success: true, message: `Deleted: ${filePath}` });
  } catch (err) { logger.error('Request error', err); res.status(500).json({ error: 'Internal server error' }); }
});

router.get('/api/cmd/memory/:userId', authenticate, async (req, res) => {
  try {
    const { userId } = req.params;
    if (!/^\d{17,20}$/.test(userId)) return res.status(400).json({ error: 'Invalid Discord user ID.' });
    const page = Math.min(10_000, Math.max(1, Number.parseInt(req.query.page, 10) || 1));
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 50));
    const rows = await db.getUserFacts(userId).catch(() => []);
    const data = (Array.isArray(rows) ? rows : []).map((entry, index) => ({
      id: String(entry?._id ?? entry?.id ?? index),
      type: 'explicit_fact',
      text: String(typeof entry === 'string' ? entry : entry?.fact ?? entry?.text ?? ''),
      createdAt: entry?.createdAt ?? null,
    })).filter(entry => entry.text).slice(0, 500);
    const skip = (page - 1) * limit;
    res.json({ success: true, data: data.slice(skip, skip + limit), total: data.length, userId, memoryMode: 'explicit-facts-only', legacyVectorDataRetained: true });
  } catch (err) { logger.error('Memory facts lookup failed', err); res.status(500).json({ error: 'Unable to load explicit memory facts.' }); }
});

router.delete('/api/cmd/memory/:userId', authenticate, async (req, res) => {
  try {
    const uid = req.params.userId;
    if (!/^\d{17,20}$/.test(uid)) return res.status(400).json({ error: 'Invalid Discord user ID.' });
    const deletedFacts = await db.deleteAllUserFacts(uid);
    const deletedLegacySessions = await db.deleteUserSessionSummaries(uid).catch(() => 0);
    // Legacy vector entries are intentionally preserved for a separately reviewed
    // data-retention migration; the new memory system never reads or writes them.
    res.json({ success: true, userId: uid, deletedFacts, deletedLegacySessions, legacyVectorDataRetained: true });
  } catch (err) { logger.error('Memory facts clear failed', err); res.status(500).json({ error: 'Unable to clear explicit memory facts.' }); }
});

router.get('/api/cmd/usage-stats', authenticate, (req, res) => {
  try {
    res.json({
      success: true,
      data: {
        image: state.imageUsage || {}, summary: state.summaryUsage || {},
        quote: state.quoteUsage || {}, starter: state.starterUsage || {},
        compliment: state.complimentUsage || {},
      }
    });
  } catch (err) { logger.error('Request error', err); res.status(500).json({ error: 'Internal server error' }); }
});

router.post('/api/cmd/toggle-feature', authenticate, async (req, res) => {
  try {
    const { feature, enabled } = req.body || {};
    if (typeof feature !== 'string' || !feature.trim()) return res.status(400).json({ error: 'feature is required.' });
    if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be a boolean.' });
    const flags = setRuntimeFeatureFlags({ [feature]: enabled });
    Object.assign(runtimeConfig, getRuntimeSettings());
    saveRuntimeConfig();
    res.json({ success: true, message: `${feature} updated.`, flags });
  } catch (err) {
    if (err instanceof TypeError) return res.status(400).json({ error: err.message });
    logger.error('Feature flag update failed', err);
    res.status(500).json({ error: 'Unable to update feature flag.' });
  }
});

router.get('/api/cmd/feature-flags', authenticate, (_req, res) => {
  // The registry is authoritative. Legacy expensive features remain explicitly off
  // and read-only; clients must use the registered flags to change live behavior.
  res.json({ success: true, data: {
    ...getRuntimeFeatureFlags(),
    ENABLE_GEMMA: false,
    CACHE_ENABLED: false,
    CYCLE_GEMMA_WITH_GEMINI: true,
    WEEKLY_SUMMARY_ENABLED: false,
    MEMORY_MODE: 'basic-history-only',
    MEMORY_CONTEXT_MESSAGES: 5,
    MEMORY_VECTOR_RETRIEVAL_ENABLED: false,
  } });
});

// ── Migration config ────────────────────────────────────────────────────────
router.get('/api/cmd/migration-config', authenticate, async (req, res) => {
  try {
    const cfg = await import('../modules/config.js');
    const defaults = {
      ENABLE_MIGRATION: cfg.MIGRATION_CONFIG?.ENABLE_MIGRATION ?? false,
      BATCH_SIZE:       cfg.MIGRATION_CONFIG?.BATCH_SIZE       ?? 50,
      BATCH_DELAY_MS:   cfg.MIGRATION_CONFIG?.BATCH_DELAY_MS   ?? 100,
    };
    const overrides = runtimeConfig.migrationConfig || {};
    res.json({ success: true, data: { ...defaults, ...overrides } });
  } catch (err) { logger.error('Request error', err); res.status(500).json({ error: 'Internal server error' }); }
});

router.put('/api/cmd/migration-config', authenticate, (req, res) => {
  try {
    if (!runtimeConfig.migrationConfig) runtimeConfig.migrationConfig = {};
    const { ENABLE_MIGRATION, BATCH_SIZE, BATCH_DELAY_MS } = req.body;
    if (ENABLE_MIGRATION !== undefined) runtimeConfig.migrationConfig.ENABLE_MIGRATION = Boolean(ENABLE_MIGRATION);
    if (BATCH_SIZE       !== undefined) runtimeConfig.migrationConfig.BATCH_SIZE       = Number(BATCH_SIZE);
    if (BATCH_DELAY_MS   !== undefined) runtimeConfig.migrationConfig.BATCH_DELAY_MS   = Number(BATCH_DELAY_MS);
    saveRuntimeConfig();
    res.json({ success: true, data: runtimeConfig.migrationConfig, message: 'Migration config saved. Restart to apply.' });
  } catch (err) { logger.error('Request error', err); res.status(500).json({ error: 'Internal server error' }); }
});

// ── Bot / State / Queue config ───────────────────────────────────────────────
router.get('/api/cmd/bot-config', authenticate, async (req, res) => {
  try {
    const cfg = await import('../modules/config.js');
    const defaults = {
      DEFAULT_RESPONSE_FORMAT:        cfg.BOT_CONFIG?.DEFAULT_RESPONSE_FORMAT        ?? 'Normal',
      WORK_IN_DMS:                    cfg.BOT_CONFIG?.WORK_IN_DMS                    ?? true,
      DEFAULT_MODEL:                  cfg.DEFAULT_MODEL                               ?? '',
      MAX_QUEUE_DEPTH_PER_USER:       cfg.MAX_QUEUE_DEPTH_PER_USER                   ?? 5,
      KEY_SWITCH_HOLD_MS:             cfg.KEY_SWITCH_HOLD_MS                         ?? 1500,
      RAM_MEDIA_SUSPEND_THRESHOLD_MB: cfg.RAM_MEDIA_SUSPEND_THRESHOLD_MB              ?? 380,
      STATE_MAX_MESSAGES:             cfg.STATE_CONFIG?.MAX_MESSAGES                 ?? 50,
      CONTEXT_BREAK_THRESHOLD_MIN:    Math.round((cfg.STATE_CONFIG?.CONTEXT_BREAK_THRESHOLD ?? 1_800_000) / 60_000),
      GEMMA_DAILY_LIMIT_PER_KEY:      cfg.GEMMA_DAILY_LIMIT_PER_KEY                  ?? 1500,
      GEMMA_DEFAULT_MODEL:            cfg.GEMMA_DEFAULT_MODEL                        ?? '',
      GEMMA_FALLBACK_MODEL:           cfg.GEMMA_FALLBACK_MODEL                       ?? '',
    };
    const overrides = runtimeConfig.botConfig || {};
    res.json({ success: true, data: { ...defaults, ...overrides } });
  } catch (err) { logger.error('Request error', err); res.status(500).json({ error: 'Internal server error' }); }
});

router.put('/api/cmd/bot-config', authenticate, (req, res) => {
  try {
    if (!runtimeConfig.botConfig) runtimeConfig.botConfig = {};
    const allowed = [
      'DEFAULT_RESPONSE_FORMAT','WORK_IN_DMS','MAX_QUEUE_DEPTH_PER_USER',
      'KEY_SWITCH_HOLD_MS','RAM_MEDIA_SUSPEND_THRESHOLD_MB',
      'STATE_MAX_MESSAGES','CONTEXT_BREAK_THRESHOLD_MIN',
      'GEMMA_DAILY_LIMIT_PER_KEY','GEMMA_DEFAULT_MODEL','GEMMA_FALLBACK_MODEL'
    ];
    for (const key of allowed) {
      if (req.body[key] !== undefined) runtimeConfig.botConfig[key] = req.body[key];
    }
    saveRuntimeConfig();
    res.json({ success: true, data: runtimeConfig.botConfig, message: 'Bot config saved. Restart to apply.' });
  } catch (err) { logger.error('Request error', err); res.status(500).json({ error: 'Internal server error' }); }
});

router.post('/api/cmd/set-embed-color', authenticate, async (req, res) => {
  try {
    const { color, guildId } = req.body;
    if (!color) return res.status(400).json({ error: 'color required.' });
    // Fix #8: Strict #RRGGBB hex validation
    if (!/^#[0-9A-Fa-f]{6}$/.test(color)) return res.status(400).json({ error: 'color must be a valid #RRGGBB hex value.' });
    if (guildId) {
      if (!state.serverSettings[guildId]) state.serverSettings[guildId] = getDefaultServerSettings();
      state.serverSettings[guildId].embedColor = color;
      if (db.saveServerSettings) await db.saveServerSettings(guildId, state.serverSettings[guildId]);
    } else {
      runtimeConfig.globalEmbedColor = color;
      saveRuntimeConfig();
    }
    res.json({ success: true, message: `Embed color set to ${color}.` });
  } catch (err) { logger.error('Request error', err); res.status(500).json({ error: 'Internal server error' }); }
});

router.get('/api/cmd/bot-info', authenticate, (req, res) => {
  try {
    const id = client?.user?.id;
    res.json({
      success: true,
      bot: {
        id, username: client?.user?.username, tag: client?.user?.tag,
        avatarURL: client?.user?.displayAvatarURL?.({ size: 256, extension: 'png' }),
        createdAt: client?.user?.createdAt?.toISOString(),
        inviteLink: id ? createBotInviteLink(id) : null,
        guilds: client?.guilds?.cache?.size || 0, wsStatus: client?.ws?.status,
        ping: client?.ws?.ping, uptime: process.uptime(), nodeVersion: process.version,
      }
    });
  } catch (err) { logger.error('Request error', err); res.status(500).json({ error: 'Internal server error' }); }
});

const wss         = new WebSocketServer({ noServer: true });
const logBuffer   = [];
const logListeners = new Set();

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  if      (url.pathname.endsWith('/ws/node'))  handleNodeRepl(ws);
  else if (url.pathname.endsWith('/ws/mongo')) handleMongoRepl(ws);
  else if (url.pathname.endsWith('/ws/shell')) handleShellRepl(ws, url.searchParams.get('cmd'));
  else if (url.pathname.endsWith('/ws/stats')) handleStatsStream(ws);
  else if (url.pathname.endsWith('/ws/logs'))  handleLogStream(ws);
  else ws.close(1008, 'Unknown path');
});

function sendWs(ws, data) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(typeof data === 'string' ? data : JSON.stringify(data));
  }
}

function handleStatsStream(ws) {
  const tick = () => {
    try {
      const mem    = process.memoryUsage();
      const guilds = client?.guilds?.cache ?? new Map();
      let totalUsers = 0;
      guilds.forEach(g => { totalUsers += (g.memberCount || 0); });
      sendWs(ws, {
        type: 'stats',
        data: {
          ping: client?.ws?.ping ?? -1, uptime: process.uptime(), serverCount: guilds.size, totalUsers,
          heapUsed: mem.heapUsed, heapTotal: mem.heapTotal, rss: mem.rss,
          sysFree: os.freemem(), sysTotal: os.totalmem(),
          globalLockdown: state.globalLockdown, debugMode: state.debugMode,
          wsStatus: client?.ws?.status === 0 ? 'READY' : 'DEGRADED',
          totalHistories: safeCount(state.chatHistories),
          totalUsers_s: safeCount(state.userSettings),
          totalServers_s: safeCount(state.serverSettings),
          disk: getDiskUsage(),
        },
        ts: Date.now(),
      });
    } catch {}
  };
  const interval = setInterval(tick, 1000);
  tick();
  ws.on('close', () => clearInterval(interval));
  ws.on('error', () => clearInterval(interval));
}

function handleLogStream(ws) {
  logBuffer.forEach(entry => sendWs(ws, JSON.stringify({ type: 'log', data: entry })));
  const listener = entry => sendWs(ws, JSON.stringify({ type: 'log', data: entry }));
  logListeners.add(listener);
  ws.on('close', () => logListeners.delete(listener));
  ws.on('error', () => logListeners.delete(listener));
}

function spawnTerminal(ws, cmd, args, env = {}) {
  const proc = spawn(cmd, args, {
    stdio: ['pipe','pipe','pipe'],
    env: { ...process.env, TERM: 'xterm-256color', ...env },
    shell: false,
  });

  const send = d => {
    const str = Buffer.isBuffer(d) ? d.toString('utf8') : String(d);
    sendWs(ws, str);
  };

  proc.stdout.on('data', send);
  proc.stderr.on('data', send);
  proc.on('error', e => send(`\r\n[Error: ${e.message}]\r\n`));
  proc.on('exit',  code => { send(`\r\n[Process exited with code ${code ?? 0}]\r\n`); try { ws.close(); } catch {} });

  ws.on('message', msg => {
    try {
      const raw = Buffer.isBuffer(msg) ? msg.toString('utf8') : String(msg);
      proc.stdin.write(raw);
    } catch {}
  });
  ws.on('close', () => { try { proc.kill('SIGTERM'); } catch {} });
  ws.on('error', () => { try { proc.kill('SIGTERM'); } catch {} });

  return proc;
}

function handleNodeRepl(ws) {
  sendWs(ws, '\r\nNode.js REPL — Ctrl+C to break, .exit to quit\r\n\r\n');
  spawnTerminal(ws, 'node', ['--experimental-repl-await', '--interactive']);
}

function handleMongoRepl(ws) {
  const uri = process.env.MONGODB_URI || '';
  if (!uri) { sendWs(ws, '\r\nMONGODB_URI is not configured; Mongo terminal disabled.\r\n'); ws.close(); return null; }
  sendWs(ws, '\r\nConnecting to MongoDB...\r\n');
  const script = `const{MongoClient,ObjectId}=require('mongodb');const repl=require('repl');(async()=>{const c=new MongoClient(${JSON.stringify(uri)},{serverSelectionTimeoutMS:8000});try{await c.connect();const db=c.db();process.stdout.write('Connected: '+db.databaseName+'\\r\\nHelpers: db, client, ObjectId, listCollections()\\r\\n\\r\\n');const r=repl.start({prompt:'mongo> ',useColors:false,ignoreUndefined:true});Object.assign(r.context,{db,client:c,ObjectId,listCollections:async()=>(await db.listCollections().toArray()).map(x=>x.name)});r.on('exit',async()=>{await c.close();process.exit(0)});}catch(e){process.stderr.write('Error: '+e.message+'\\r\\n');process.exit(1);}})();`;
  spawnTerminal(ws, 'node', ['-e', script]);
}

function handleShellRepl(ws, initialCmd) {
  sendWs(ws, '\r\nBash shell — type exit to quit\r\n\r\n');
  const proc = spawnTerminal(ws, '/bin/bash', [], { PS1: '\\w $ ' });
  if (initialCmd) setTimeout(() => { try { proc.stdin.write(initialCmd + '\n'); } catch {} }, 300);
}

// ── Rate-limit config (RPM per model per key) ────────────────────────────────
router.get('/api/config/rate-limits', authenticate, (req, res) => {
  try {
    // Return stored overrides merged with sensible defaults so the UI always
    // has something to display even before any override has been saved.
    const defaults = {
      REQUESTS_PER_MINUTE: 15,
      WINDOW_DURATION_MS:  60_000,
      COOLDOWN_DURATION_MS: 60_000,
      MODEL_REQUESTS_PER_MINUTE: {
        'gemini-3.5-flash-lite': null  // null = Infinity / unlimited
      },
      RETRY_DELAYS: {
        FORBIDDEN:    3_000,
        RATE_LIMIT:   2_500,
        SERVER_ERROR: 1_000,
        DEFAULT:      1_000
      }
    };
    const overrides = runtimeConfig.rateLimits || {};
    res.json({ success: true, data: { ...defaults, ...overrides } });
  } catch (err) { logger.error('Request error', err); res.status(500).json({ error: 'Internal server error' }); }
});

router.put('/api/config/rate-limits', authenticate, (req, res) => {
  try {
    if (!runtimeConfig.rateLimits) runtimeConfig.rateLimits = {};
    const allowed = [
      'REQUESTS_PER_MINUTE','WINDOW_DURATION_MS','COOLDOWN_DURATION_MS',
      'MODEL_REQUESTS_PER_MINUTE','RETRY_DELAYS'
    ];
    for (const key of allowed) {
      if (req.body[key] !== undefined) runtimeConfig.rateLimits[key] = req.body[key];
    }
    saveRuntimeConfig();
    res.json({ success: true, data: runtimeConfig.rateLimits, message: 'Rate-limit config saved. Restart to apply.' });
  } catch (err) { logger.error('Request error', err); res.status(500).json({ error: 'Internal server error' }); }
});

// ── Full bot config (all tuneable knobs from modules/config.js) ──────────────
router.get('/api/config/all', authenticate, async (req, res) => {
  try {
    const cfg = await import('../modules/config.js');
    res.json({
      success: true,
      data: {
        // ── AI routing ──────────────────────────────────────────────────────
        ENABLE_GEMMA:            cfg.ENABLE_GEMMA            ?? false,
        GEMMA_DEFAULT_MODEL:     cfg.GEMMA_DEFAULT_MODEL     ?? '',
        GEMMA_FALLBACK_MODEL:    cfg.GEMMA_FALLBACK_MODEL    ?? '',
        CYCLE_GEMMA_WITH_GEMINI: cfg.CYCLE_GEMMA_WITH_GEMINI ?? false,
        // ── Models ─────────────────────────────────────────────────────────
        DEFAULT_MODEL:           cfg.DEFAULT_MODEL           ?? '',
        MODELS:                  cfg.MODELS                  ?? {},
        MODEL_FALLBACK_CHAIN:    cfg.MODEL_FALLBACK_CHAIN    ?? [],
        MODEL_CALL_THRESHOLDS:   cfg.MODEL_CALL_THRESHOLDS   ?? {},
        GEMMA_DAILY_LIMIT_PER_KEY: cfg.GEMMA_DAILY_LIMIT_PER_KEY ?? 1500,
        // ── Feature flags ──────────────────────────────────────────────────
        CACHE_ENABLED:           cfg.CACHE_ENABLED           ?? false,
        PDF_ENABLED_FOR_GEMINI:  cfg.PDF_ENABLED_FOR_GEMINI  ?? false,
        CROSS_CONTEXT_ENABLED:   cfg.CROSS_CONTEXT_ENABLED   ?? false,
        // ── Queue & media ──────────────────────────────────────────────────
        MAX_QUEUE_DEPTH_PER_USER:       cfg.MAX_QUEUE_DEPTH_PER_USER        ?? 5,
        KEY_SWITCH_HOLD_MS:             cfg.KEY_SWITCH_HOLD_MS              ?? 1500,
        RAM_MEDIA_SUSPEND_THRESHOLD_MB: cfg.RAM_MEDIA_SUSPEND_THRESHOLD_MB  ?? 380,
        // ── State ──────────────────────────────────────────────────────────
        STATE_MAX_MESSAGES:          cfg.STATE_CONFIG?.MAX_MESSAGES          ?? 50,
        CONTEXT_BREAK_THRESHOLD_MIN: Math.round((cfg.STATE_CONFIG?.CONTEXT_BREAK_THRESHOLD ?? 1_800_000) / 60_000),
        // ── Memory boundary ─────────────────────────────────────────────────
        MEMORY_MODE: 'basic-history-only',
        MEMORY_CONTEXT_MESSAGES: 5,
        MEMORY_VECTOR_RETRIEVAL_ENABLED: false,
        // ── Migration ──────────────────────────────────────────────────────
        MIGRATION_ENABLE:     cfg.MIGRATION_CONFIG?.ENABLE_MIGRATION ?? false,
        MIGRATION_BATCH_SIZE: cfg.MIGRATION_CONFIG?.BATCH_SIZE       ?? 50,
        MIGRATION_DELAY_MS:   cfg.MIGRATION_CONFIG?.BATCH_DELAY_MS   ?? 100,
        // ── Runtime overrides (layered on top) ─────────────────────────────
        _runtimeOverrides: (() => { const { _keyStats, ...safe } = runtimeConfig; return safe; })(),
        FEATURE_FLAGS: getRuntimeFeatureFlags(),
      }
    });
  } catch (err) { logger.error('Request error', err); res.status(500).json({ error: 'Internal server error' }); }
});

// ── Versioned, reversible settings migrations ───────────────────────────────
// The legacy /api/cmd/migrate paths remain supported but delegate to the new
// journaled runner so old console actions inherit preview and rollback support.
async function runMigrationFromRequest(req, options = {}) {
  const { runSettingsMigration } = await import('../migrations/SettingsMigrationRunner.js');
  return runSettingsMigration({
    ...options,
    actor: req.sessionUser?.email || req.sessionUser?.discordId || req.sessionUser?.id || 'unknown',
  });
}

router.get('/api/migrations/fields', authenticate, async (_req, res) => {
  try {
    const { MIGRATION_SCHEMA } = await import('../migrations/SettingsMigrationRunner.js');
    res.json({ success: true, schema: MIGRATION_SCHEMA });
  } catch (error) {
    logger.error('Could not read migration schema', error);
    res.status(500).json({ error: 'Migration schema unavailable.' });
  }
});

router.get('/api/migrations', authenticate, async (req, res) => {
  try {
    const { listSettingsMigrations } = await import('../migrations/SettingsMigrationRunner.js');
    res.json({ success: true, migrations: await listSettingsMigrations({ limit: req.query.limit }) });
  } catch (error) {
    logger.error('Could not list migrations', error);
    res.status(500).json({ error: 'Migration history unavailable.' });
  }
});

router.post('/api/migrations/preview', authenticate, async (req, res) => {
  try {
    const { previewSettingsMigration } = await import('../migrations/SettingsMigrationRunner.js');
    const result = await previewSettingsMigration({ ...req.body, dryRun: true, actor: req.sessionUser?.email || req.sessionUser?.id });
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message || 'Invalid migration options.' });
  }
});

router.post('/api/migrations', authenticate, async (req, res) => {
  try {
    const result = await runMigrationFromRequest(req, { ...req.body, dryRun: false });
    res.status(result.success ? 200 : 207).json(result);
  } catch (error) {
    const status = error instanceof TypeError || error instanceof RangeError ? 400 : 500;
    logger.error('Settings migration failed', error);
    res.status(status).json({ error: status === 400 ? error.message : 'Migration failed. Inspect the migration run record for details.' });
  }
});

router.get('/api/migrations/:migrationId', authenticate, async (req, res) => {
  try {
    const { getSettingsMigration } = await import('../migrations/SettingsMigrationRunner.js');
    const migration = await getSettingsMigration(req.params.migrationId);
    if (!migration) return res.status(404).json({ error: 'Migration not found.' });
    res.json({ success: true, migration });
  } catch (error) {
    logger.error('Could not read migration', error);
    res.status(500).json({ error: 'Migration status unavailable.' });
  }
});

router.post('/api/migrations/:migrationId/rollback', authenticate, async (req, res) => {
  try {
    const { rollbackSettingsMigration } = await import('../migrations/SettingsMigrationRunner.js');
    const actor = req.sessionUser?.email || req.sessionUser?.discordId || req.sessionUser?.id || 'unknown';
    const result = await rollbackSettingsMigration(req.params.migrationId, actor);
    res.status(result.success ? 200 : 207).json(result);
  } catch (error) {
    const status = error.message === 'Migration not found.' ? 404 : error instanceof TypeError ? 400 : 500;
    logger.error('Migration rollback failed', error);
    res.status(status).json({ error: status === 500 ? 'Migration rollback failed.' : error.message });
  }
});

router.get('/api/settings/defaults', authenticate, async (_req, res) => {
  res.json({ success: true, overrides: getSettingDefaults(), users: getDefaultUserSettings(), servers: getDefaultServerSettings() });
});

router.put('/api/settings/defaults', authenticate, async (req, res) => {
  try {
    const current = getSettingDefaults();
    const users = { ...current.users, ...(req.body?.users || {}) };
    const servers = { ...current.servers, ...(req.body?.servers || {}) };
    const saved = await saveSettingDefaultsToDB({ users, servers });
    res.json({ success: true, overrides: saved, users: getDefaultUserSettings(), servers: getDefaultServerSettings() });
  } catch (error) {
    res.status(400).json({ error: error.message || 'Invalid setting defaults.' });
  }
});

router.post('/api/cmd/migrate', authenticate, async (req, res) => {
  try {
    const result = await runMigrationFromRequest(req, {
      ...req.body,
      scope: req.body?.scope || 'both',
      mode: req.body?.mode || ((req.body?.userIds?.length || req.body?.guildIds?.length) ? 'selected' : 'all'),
    });
    res.status(result.success ? 200 : 207).json(result);
  } catch (error) {
    const status = error instanceof TypeError || error instanceof RangeError ? 400 : 500;
    res.status(status).json({ error: status === 400 ? error.message : 'Migration failed.' });
  }
});

router.post('/api/cmd/migrate/servers', authenticate, async (req, res) => {
  try {
    const result = await runMigrationFromRequest(req, { ...req.body, scope: 'servers', mode: req.body?.mode || 'all' });
    res.status(result.success ? 200 : 207).json(result);
  } catch (error) { res.status(error instanceof TypeError ? 400 : 500).json({ error: error.message || 'Migration failed.' }); }
});

router.post('/api/cmd/migrate/users', authenticate, async (req, res) => {
  try {
    const result = await runMigrationFromRequest(req, { ...req.body, scope: 'users', mode: req.body?.mode || 'all' });
    res.status(result.success ? 200 : 207).json(result);
  } catch (error) { res.status(error instanceof TypeError ? 400 : 500).json({ error: error.message || 'Migration failed.' }); }
});

router.get('/api/cmd/migrate/fields', authenticate, async (_req, res) => {
  try {
    const { MIGRATION_SCHEMA } = await import('../migrations/SettingsMigrationRunner.js');
    res.json({ success: true, ...MIGRATION_SCHEMA });
  } catch { res.status(500).json({ error: 'Migration schema unavailable.' }); }
});

export function mountDashboard(app, httpServer) {
  roleAssignmentsReady = loadPersistedRoleAssignments().catch(error => logger.warn(`Console role initialization failed: ${error.message}`));
  router.get('/', (_req, res) => {
    if (CONSOLE_URL && !CONSOLE_URL.startsWith('/')) return res.redirect(302, CONSOLE_URL);
    return res.status(200).json({
      service: 'Helium API',
      console: 'The web console is maintained in a separate repository.',
      apiBase: '/dashboard',
      authentication: { google: '/dashboard/auth/google', discord: '/dashboard/auth/discord' },
      health: '/health',
    });
  });
  app.use('/dashboard', router);
  app.get('/dashboard', (_req, res) => {
    if (CONSOLE_URL && !CONSOLE_URL.startsWith('/')) return res.redirect(302, CONSOLE_URL);
    return res.redirect('/dashboard/');
  });

  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith('/dashboard/ws/')) return;
    // Fix #3: Read auth token from HttpOnly cookie only — never from URL query param
    const origin = req.headers.origin;
    if (origin && !isWebSocketOriginAllowed(origin)) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return; }
    const session = lookupSession(getSessionToken(req));
    if (!session) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
    const terminalPath = /\/ws\/(node|mongo|shell)$/.test(url.pathname);
    if (terminalPath && (!ENABLE_ADMIN_TERMINALS || !authorize(session, PERMISSIONS.OWNER_MANAGE, null).allowed)) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return; }
    if (!terminalPath && !authorize(session, PERMISSIONS.SENSITIVE_READ, null).allowed) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  });

  logger.info('Dashboard mounted at /dashboard');
}

export const isGlobalLockdown = () => state.globalLockdown === true;
