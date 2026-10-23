/**
 * Server-side authorization policy for Helium's administration API.
 *
 * Roles are deliberately represented as a permission hierarchy rather than
 * compared by role-name strings. Server-scoped grants only apply to their
 * explicitly listed Discord guild IDs. The browser is never trusted to decide
 * whether an action is allowed.
 *
 * Environment variable format:
 * HELIUM_STAFF_ROLES_JSON='[{"identityType":"email","identity":"staff@example.com","role":"admin","level":"senior","guildIds":["123"]}]'
 */

const ROLE_SCORE = Object.freeze({
  owner: 100,
  'admin-superior': 80,
  'admin-senior': 70,
  'admin-junior': 60,
  'moderator-superior': 50,
  'moderator-senior': 40,
  'moderator-junior': 30,
});

const ROLE_LEVELS = new Set(['superior', 'senior', 'junior']);
let STAFF_ROLES = loadStaffRoles();

/** Permissions required by API actions. Owner-only operations intentionally
 * remain owner-only even if a staff member has a high score. */
export const PERMISSIONS = Object.freeze({
  CONSOLE_READ: 'console:read',
  CONSOLE_WRITE: 'console:write',
  MODERATE_MEMBERS: 'moderate:members',
  SENSITIVE_READ: 'sensitive:read',
  OWNER_MANAGE: 'owner:manage',
});

const PERMISSION_POLICY = Object.freeze({
  [PERMISSIONS.CONSOLE_READ]: { minimumScore: ROLE_SCORE['moderator-junior'] },
  [PERMISSIONS.CONSOLE_WRITE]: { minimumScore: ROLE_SCORE['admin-junior'] },
  [PERMISSIONS.MODERATE_MEMBERS]: { minimumScore: ROLE_SCORE['moderator-senior'] },
  [PERMISSIONS.SENSITIVE_READ]: { minimumScore: ROLE_SCORE['admin-superior'] },
  [PERMISSIONS.OWNER_MANAGE]: { minimumScore: ROLE_SCORE.owner, ownerOnly: true },
});

function loadStaffRoles() {
  const raw = process.env.HELIUM_STAFF_ROLES_JSON;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new TypeError('Expected a JSON array');
    return parsed.filter((grant) => {
      if (!grant || typeof grant !== 'object') return false;
      if (!['email', 'discordId'].includes(grant.identityType)) return false;
      if (typeof grant.identity !== 'string' || !grant.identity.trim()) return false;
      if (!['admin', 'moderator'].includes(grant.role) || !ROLE_LEVELS.has(grant.level)) return false;
      // Hybrid policy: only the environment-configured owner is global.
      return grant.scope !== 'global' && Array.isArray(grant.guildIds) && grant.guildIds.length > 0;
    }).map((grant) => ({
      identityType: grant.identityType,
      identity: grant.identityType === 'email' ? grant.identity.trim().toLowerCase() : grant.identity.trim(),
      role: grant.role,
      level: grant.level,
      scope: 'guild',
      guildIds: Array.isArray(grant.guildIds) ? [...new Set(grant.guildIds.map(String))] : [],
    }));
  } catch (error) {
    // A malformed role map must not grant access. The application can still
    // start so the owner can fix deployment configuration and redeploy.
    process.stderr.write(`[HeliumSecurity] Invalid HELIUM_STAFF_ROLES_JSON: ${error.message}\n`);
    return [];
  }
}

function identifiersFor(identity = {}) {
  const values = [];
  if (typeof identity.email === 'string' && identity.email.trim()) {
    values.push({ type: 'email', value: identity.email.trim().toLowerCase() });
  }
  if (typeof identity.discordId === 'string' && identity.discordId.trim()) {
    values.push({ type: 'discordId', value: identity.discordId.trim() });
  }
  if (typeof identity.id === 'string' && identity.provider === 'discord') {
    values.push({ type: 'discordId', value: identity.id.trim() });
  }
  return values;
}

function isOwner(identity = {}) {
  const ownerEmail = (process.env.HELIUM_OWNER_EMAIL || '').trim().toLowerCase();
  const ownerDiscordId = (process.env.HELIUM_OWNER_DISCORD_ID || '').trim();
  return Boolean(
    (ownerEmail && typeof identity.email === 'string' && identity.email.trim().toLowerCase() === ownerEmail) ||
    (ownerDiscordId && (identity.discordId === ownerDiscordId || (identity.provider === 'discord' && identity.id === ownerDiscordId)))
  );
}

/** Return the highest grant applicable to the identity and target guild. */
export function resolveRole(identity = {}, guildId = null) {
  if (isOwner(identity)) return { role: 'owner', score: ROLE_SCORE.owner, scope: 'global', guildId: null, isOwner: true };
  const identifiers = identifiersFor(identity);
  let best = null;

  for (const identifier of identifiers) {
    for (const grant of STAFF_ROLES) {
      if (grant.identityType !== identifier.type || grant.identity !== identifier.value) continue;
      if (grant.scope === 'guild' && (!guildId || !grant.guildIds.includes(String(guildId)))) continue;
      const role = `${grant.role}-${grant.level}`;
      const score = ROLE_SCORE[role];
      if (score && (!best || score > best.score)) best = { role, score, scope: grant.scope, guildId: grant.scope === 'guild' ? String(guildId) : null, isOwner: false };
    }
  }
  return best;
}


/** Whether an identity has any owner or staff grant (guild-scoped grants count
 * here so users can complete OAuth before selecting a managed guild). */
export function isIdentityAuthorized(identity = {}) {
  if (isOwner(identity)) return true;
  const identifiers = identifiersFor(identity);
  return STAFF_ROLES.some((grant) => identifiers.some((item) => item.type === grant.identityType && item.value === grant.identity));
}

/** Return safe, editable staff assignments (never includes owner credentials). */
export function getStaffRoleAssignments() {
  return STAFF_ROLES.map(grant => ({ ...grant, guildIds: [...grant.guildIds] }));
}

/**
 * Atomically replace staff grants after validating every item. The owner is
 * environment-only and cannot be created, demoted, or removed through this API.
 */
export function replaceStaffRoleAssignments(assignments) {
  if (!Array.isArray(assignments) || assignments.length > 500) {
    throw new TypeError('Role assignments must be an array with at most 500 entries.');
  }
  const normalized = [];
  const seen = new Set();
  for (const grant of assignments) {
    if (!grant || typeof grant !== 'object' || Array.isArray(grant)) throw new TypeError('Each role assignment must be an object.');
    if (!['email', 'discordId'].includes(grant.identityType)) throw new TypeError('identityType must be email or discordId.');
    if (typeof grant.identity !== 'string' || !grant.identity.trim() || grant.identity.length > 320) throw new TypeError('identity must be a non-empty string.');
    if (!['admin', 'moderator'].includes(grant.role) || !ROLE_LEVELS.has(grant.level)) throw new TypeError('Role must be admin/moderator with superior/senior/junior level.');
    if (grant.scope === 'global') throw new TypeError('Only the environment-configured owner may have global scope.');
    const scope = 'guild';
    if (!Array.isArray(grant.guildIds) || grant.guildIds.length < 1 || grant.guildIds.length > 500) throw new TypeError('Guild-scoped grants require 1–500 guild IDs.')
    const identity = grant.identityType === 'email' ? grant.identity.trim().toLowerCase() : grant.identity.trim();
    if (grant.identityType === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identity)) throw new TypeError('Invalid email identity.');
    if (grant.identityType === 'discordId' && !/^\d{17,20}$/.test(identity)) throw new TypeError('Discord identities must be snowflake IDs.');
    const guildIds = [...new Set(grant.guildIds.map(String))];
    if (guildIds.some(id => !/^\d{17,20}$/.test(id))) throw new TypeError('Each guild ID must be a Discord snowflake.');
    const key = `${grant.identityType}:${identity}:${grant.role}:${grant.level}:${scope}:${guildIds.slice().sort().join(',')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push({ identityType: grant.identityType, identity, role: grant.role, level: grant.level, scope, guildIds });
  }
  STAFF_ROLES = normalized;
  return getStaffRoleAssignments();
}

/** List guilds the identity can manage; null means explicitly global access. */
export function getAccessibleGuildIds(identity = {}) {
  if (isOwner(identity)) return null;
  const identifiers = identifiersFor(identity);
  const grants = STAFF_ROLES.filter(grant => identifiers.some(item => item.type === grant.identityType && item.value === grant.identity));
  return [...new Set(grants.flatMap(grant => grant.guildIds))];
}

export function getBestRoleAssignment(identity = {}) {
  if (isOwner(identity)) return { role: 'owner', level: null, scope: 'global', guildIds: [] };
  const identifiers = identifiersFor(identity);
  const grants = STAFF_ROLES.filter(grant => identifiers.some(item => item.type === grant.identityType && item.value === grant.identity));
  grants.sort((a, b) => ROLE_SCORE[`${b.role}-${b.level}`] - ROLE_SCORE[`${a.role}-${a.level}`]);
  return grants.length ? { ...grants[0], guildIds: [...grants[0].guildIds] } : null;
}

export function describeRoleHierarchy() {
  return {
    owner: ['owner:manage', 'console:read', 'console:write', 'sensitive:read', 'moderate:members'],
    admin: ['superior', 'senior', 'junior'],
    moderator: ['superior', 'senior', 'junior'],
    permissions: Object.keys(PERMISSION_POLICY),
  };
}

/**
 * Authorize one requested action. Guild-scoped grants must be evaluated against
 * a guild ID taken from the route/body, never a client-supplied role value.
 */
export function authorize(identity, permission, guildId = null) {
  const policy = PERMISSION_POLICY[permission];
  if (!policy) return { allowed: false, reason: 'unknown_permission', role: null };
  const role = resolveRole(identity, guildId);
  if (!role) return { allowed: false, reason: 'role_required', role: null };
  if (policy.ownerOnly && !role.isOwner) return { allowed: false, reason: 'owner_required', role };
  if (role.score < policy.minimumScore) return { allowed: false, reason: 'insufficient_role', role };
  return { allowed: true, reason: null, role };
}

/** Map console API routes to least-privilege permissions.
 *
 * Unclassified operations are owner-only by default. New routes must be added
 * to an explicit policy before staff can access them; this prevents an
 * accidentally added write endpoint from inheriting broad admin privileges.
 */
export function requiredPermissionForRequest({ method = 'GET', path = '' } = {}) {
  const route = String(path).split('?')[0].replace(/\/+$/, '') || '/';
  const verb = String(method).toUpperCase();
  const isRead = ['GET', 'HEAD', 'OPTIONS'].includes(verb);
  const startsWithAny = (prefixes) => prefixes.some((prefix) => route === prefix || route.startsWith(`${prefix}/`));

  const ownerOnlyPrefixes = [
    '/api/security/roles', '/api/ai/config', '/api/migrations', '/api/settings/defaults',
    '/api/config/runtime', '/api/config/modules', '/api/config/base', '/api/config/rate-limits', '/api/config/all',
    '/api/db', '/api/files',
    '/api/cmd/save-state', '/api/cmd/reload-state', '/api/cmd/clear-history',
    '/api/cmd/all-histories', '/api/cmd/chat-history', '/api/cmd/switch-api-key', '/api/cmd/switch-to-key',
    '/api/cmd/lockdown', '/api/cmd/announce', '/api/cmd/announce-users', '/api/cmd/leave-server',
    '/api/cmd/reset-server', '/api/cmd/reset-user-settings', '/api/cmd/clear-image-usage',
    '/api/cmd/clear-summary-usage', '/api/cmd/clear-quote-usage', '/api/cmd/clear-reminders',
    '/api/cmd/reminders', '/api/cmd/clear-birthdays', '/api/cmd/birthdays', '/api/cmd/clear-starter-usage',
    '/api/cmd/clear-compliment-usage', '/api/cmd/dm-all-owners', '/api/cmd/reload-commands',
    '/api/cmd/purge-blacklist', '/api/cmd/blacklisted-users', '/api/cmd/send-dm', '/api/cmd/send-channel',
    '/api/cmd/restart', '/api/cmd/toggle-debug', '/api/cmd/set-presence', '/api/cmd/set-model',
    '/api/cmd/set-embed-color', '/api/cmd/clear-all-usage', '/api/cmd/migration-config',
    '/api/cmd/toggle-feature', '/api/cmd/feature-flags', '/api/cmd/bot-config',
    '/api/cmd/attachment-grants', '/api/cmd/memory', '/api/cmd/user-settings',
  ];
  if (startsWithAny(ownerOnlyPrefixes)) {
    if (isRead && ['/api/cmd/user-settings'].some(prefix => route === prefix || route.startsWith(`${prefix}/`))) {
      return PERMISSIONS.SENSITIVE_READ;
    }
    if (isRead && ['/api/cmd/reminders', '/api/cmd/birthdays'].some(prefix => route === prefix || route.startsWith(`${prefix}/`))) {
      return PERMISSIONS.OWNER_MANAGE;
    }
    return PERMISSIONS.OWNER_MANAGE;
  }

  // Sensitive cross-user data and global runtime metrics require an elevated
  // read role. Guild-targeted routes still require the caller's explicit grant
  // for the guild parsed independently by dashboard/server.js.
  const sensitiveReadPrefixes = [
    '/api/audit/logs', '/api/cmd/user-profile', '/api/cmd/usage-stats', '/api/cmd/api-key-stats', '/api/cmd/state-snapshot',
  ];
  if (isRead && startsWithAny(sensitiveReadPrefixes)) return PERMISSIONS.SENSITIVE_READ;

  if (startsWithAny(['/api/cmd/kick-member', '/api/cmd/ban-member', '/api/cmd/set-nickname', '/api/cmd/blacklist', '/api/cmd/unblacklist'])) {
    return PERMISSIONS.MODERATE_MEMBERS;
  }

  if (route === '/api/cmd/server-settings' || route.startsWith('/api/cmd/server-settings/')) {
    return isRead ? PERMISSIONS.CONSOLE_READ : PERMISSIONS.CONSOLE_WRITE;
  }

  const safeReadPrefixes = [
    '/api/stats', '/api/cmd/servers', '/api/cmd/models', '/api/cmd/bot-info', '/api/cmd/get-presence',
    '/api/cmd/invite-link', '/api/cmd/resolve-username', '/api/cmd/guild-info', '/api/cmd/channels',
    '/api/cmd/members', '/api/config/activities', '/api/auth/permissions',
  ];
  if (isRead && startsWithAny(safeReadPrefixes)) return PERMISSIONS.CONSOLE_READ;

  // Anything not explicitly granted requires Owner authorization, even if it
  // happens to be a GET today. This is the fail-closed default for new routes.
  return PERMISSIONS.OWNER_MANAGE;
}
