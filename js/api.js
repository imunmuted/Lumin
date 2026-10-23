import { BASE_URL } from './config.js';

let csrfToken = null;

async function req(method, path, body) {
  // Fix #1/#10: Cookie is sent automatically; no token header needed
  const headers = { 'Content-Type': 'application/json' };
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase()) && csrfToken) headers['X-CSRF-Token'] = csrfToken;
  const opts = { method, headers, credentials: 'include' };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res  = await fetch(`${BASE_URL}${path}`, opts);
  let data;
  try { data = await res.json(); } catch { data = { error: `HTTP ${res.status}` }; }
  if (res.status === 401) data._authError = true;
  if (path === '/auth/me' && typeof data.csrfToken === 'string') csrfToken = data.csrfToken;
  if (path === '/auth/logout' && res.ok) csrfToken = null;
  return data;
}

const get  = p       => req('GET',    p);
const post = (p, b)  => req('POST',   p, b);
const put  = (p, b)  => req('PUT',    p, b);
const del  = (p, b)  => req('DELETE', p, b);

export const api = {
  getStats:            ()              => get('/api/stats'),
  getCommandCatalog:   ()              => get('/api/cmd/command-catalog'),
  getAuditLogs:        (params={})     => get(`/api/audit/logs?${new URLSearchParams(params)}`),
  getServers:          ()              => get('/api/cmd/servers'),
  saveState:           ()              => post('/api/cmd/save-state'),
  reloadState:         ()              => post('/api/cmd/reload-state'),
  clearHistory:        (id)            => post('/api/cmd/clear-history', id ? {id} : {}),
  allHistories:        ()              => get('/api/cmd/all-histories'),
  getChatHistory:      (id)            => get(`/api/cmd/chat-history/${id}`),
  blacklistUser:       (userId,guildId)=> post('/api/cmd/blacklist',    {userId,guildId}),
  unblacklistUser:     (userId,guildId)=> post('/api/cmd/unblacklist',  {userId,guildId}),
  getBlacklisted:      ()              => get('/api/cmd/blacklisted-users'),
  purgeBlacklist:      ()              => post('/api/cmd/purge-blacklist'),
  switchApiKey:        ()              => post('/api/cmd/switch-api-key'),
  switchToKey:         (idx)           => post(`/api/cmd/switch-to-key/${idx}`),
  getApiKeyStats:      ()              => get('/api/cmd/api-key-stats'),
  setLockdown:         (enabled)       => post('/api/cmd/lockdown',       {enabled}),
  announce:            (p)             => post('/api/cmd/announce',        p),
  announceUsers:       (p)             => post('/api/cmd/announce-users',  p),
  leaveServer:         (guildId)       => post('/api/cmd/leave-server',   {guildId}),
  resetServer:         (guildId)       => post('/api/cmd/reset-server',   {guildId}),
  getServerSettings:   (guildId)       => get(`/api/cmd/server-settings/${guildId}`),
  setServerSettings:   (guildId,data)  => put(`/api/cmd/server-settings/${guildId}`, data),
  getUserSettings:     (userId)        => get(`/api/cmd/user-settings/${userId}`),
  setUserSettings:     (userId,data)   => put(`/api/cmd/user-settings/${userId}`, data),
  resetUserSettings:   (userId)        => post('/api/cmd/reset-user-settings', {userId}),
  clearImageUsage:     ()              => post('/api/cmd/clear-image-usage'),
  clearSummaryUsage:   ()              => post('/api/cmd/clear-summary-usage'),
  clearQuoteUsage:     ()              => post('/api/cmd/clear-quote-usage'),
  clearStarterUsage:   ()              => post('/api/cmd/clear-starter-usage'),
  clearComplimentUsage:()              => post('/api/cmd/clear-compliment-usage'),
  clearAllUsage:       ()              => post('/api/cmd/clear-all-usage'),
  clearReminders:      ()              => post('/api/cmd/clear-reminders'),
  clearBirthdays:      ()              => post('/api/cmd/clear-birthdays'),
  getReminders:        ()              => get('/api/cmd/reminders'),
  getBirthdays:        ()              => get('/api/cmd/birthdays'),
  toggleDebug:         ()              => post('/api/cmd/toggle-debug'),
  setPresence:         (p)             => post('/api/cmd/set-presence',   p),
  getPresence:         ()              => get('/api/cmd/get-presence'),
  sendDm:              (userId,msg)    => post('/api/cmd/send-dm',        {userId,message:msg}),
  dmAllOwners:         (message)       => post('/api/cmd/dm-all-owners',  {message}),
  restart:             ()              => post('/api/cmd/restart'),
  reloadCommands:      ()              => post('/api/cmd/reload-commands'),
  fetchUserProfile:    (userId)        => get(`/api/cmd/user-profile/${userId}`),
  resolveUsername:     (username)      => post('/api/cmd/resolve-username', {username}),
  getGuildInfo:        (guildId)       => get(`/api/cmd/guild-info/${guildId}`),
  getChannels:         (guildId)       => get(`/api/cmd/channels/${guildId}`),
  getMembers:          (guildId)       => get(`/api/cmd/members/${guildId}`),
  sendChannel:         (channelId,msg,embed) => post('/api/cmd/send-channel', {channelId, message:msg, embed}),
  kickMember:          (guildId,userId,reason) => post('/api/cmd/kick-member', {guildId,userId,reason}),
  banMember:           (guildId,userId,reason) => post('/api/cmd/ban-member',  {guildId,userId,reason}),
  setNickname:         (guildId,nickname) => post('/api/cmd/set-nickname', {guildId,nickname}),
  inviteLink:          ()              => get('/api/cmd/invite-link'),
  stateSnapshot:       ()              => get('/api/cmd/state-snapshot'),
  getModels:           ()              => get('/api/cmd/models'),
  setModel:            (model)         => post('/api/cmd/set-model', {model}),
  getFeatureFlags:     ()              => get('/api/cmd/feature-flags'),
  toggleFeature:       (feature,enabled) => post('/api/cmd/toggle-feature', {feature,enabled}),
  setEmbedColor:       (color,guildId) => post('/api/cmd/set-embed-color', {color,guildId}),
  botInfo:             ()              => get('/api/cmd/bot-info'),
  getMemory:           (userId,page)   => get(`/api/cmd/memory/${userId}?page=${page||1}&limit=50`),
  deleteMemory:        (userId)        => del(`/api/cmd/memory/${userId}`),
  usageStats:          ()              => get('/api/cmd/usage-stats'),
  getActivities:       ()              => get('/api/config/activities'),
  getRuntimeConfig:    ()              => get('/api/config/runtime'),
  setRuntimeConfig:    (data)          => put('/api/config/runtime', data),
  clearRuntimeConfig:  ()              => del('/api/config/runtime'),
  getModulesConfig:    ()              => get('/api/config/modules'),
  setModulesConfig:    (content)       => put('/api/config/modules', {content}),
  resetModulesConfig:  ()              => post('/api/config/modules/reset'),
  getBaseConfig:       ()              => get('/api/config/base'),
  setBaseConfig:       (content)       => put('/api/config/base', {content}),
  resetBaseConfig:     ()              => post('/api/config/base/reset'),
  dbCollections:       ()              => get('/api/db/collections'),
  dbCollection:        (name,page)     => get(`/api/db/collection/${name}?page=${page||1}&limit=50`),
  dbUpdateDoc:         (col,id,data)   => put(`/api/db/collection/${col}/${id}`, data),
  dbDeleteDoc:         (col,id)        => del(`/api/db/collection/${col}/${id}`),
  files:               (path)          => get(`/api/files?path=${encodeURIComponent(path||'')}`),
  saveFile:            (filePath,content) => put('/api/files', {filePath,content}),
  deleteFile:          (filePath)      => del('/api/files', {filePath}),
  authMe:              ()              => get('/auth/me'),
  authLogout:          ()              => post('/auth/logout'),
  authConfig:          ()              => get('/auth/config'),
  verifyRecaptcha:     (token, provider) => post('/auth/verify-recaptcha', {token, provider}),
  getMigrationConfig:  ()              => get('/api/cmd/migration-config'),
  setMigrationConfig:  (data)          => put('/api/cmd/migration-config', data),
  getBotConfig:        ()              => get('/api/cmd/bot-config'),
  setBotConfig:        (data)          => put('/api/cmd/bot-config', data),
  getRateLimits:       ()              => get('/api/config/rate-limits'),
  setRateLimits:       (data)          => put('/api/config/rate-limits', data),
  getAllConfig:        ()              => get('/api/config/all'),
  runMigration:        (data)          => post('/api/cmd/migrate', data),
  getMigrateFields:    ()              => get('/api/cmd/migrate/fields'),
};
