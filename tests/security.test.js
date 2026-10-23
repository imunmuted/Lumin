import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveContainedPath } from '../security/pathPolicy.js';
import { canAnalyzeAttachments } from '../security/attachmentPolicy.js';
import { authorize, getAccessibleGuildIds, PERMISSIONS, replaceStaffRoleAssignments, requiredPermissionForRequest } from '../security/authorization.js';

const GUILD_A = '12345678901234567';
const GUILD_B = '22345678901234567';

test('path policy permits paths inside the root', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'helium-root-'));
  try {
    fs.writeFileSync(path.join(root, 'safe.txt'), 'safe');
    assert.equal(resolveContainedPath(root, 'safe.txt'), path.join(root, 'safe.txt'));
    assert.throws(() => resolveContainedPath(root, '../outside.txt'), { code: 'PATH_OUTSIDE_ROOT' });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('path policy rejects symlink escapes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'helium-root-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'helium-outside-'));
  try {
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'no');
    fs.symlinkSync(outside, path.join(root, 'link'), 'dir');
    assert.throws(() => resolveContainedPath(root, 'link/secret.txt'), { code: 'PATH_OUTSIDE_ROOT' });
  } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); }
});

test('attachment processing is denied unless a specific grant exists', () => {
  assert.equal(canAnalyzeAttachments({ userId: '123', state: {}, env: {} }), false);
  assert.equal(canAnalyzeAttachments({ userId: '123', state: { userSettings: { '123': { attachmentProcessingEnabled: true } } }, env: {} }), true);
  assert.equal(canAnalyzeAttachments({ userId: '123', state: {}, env: { HELIUM_ATTACHMENT_ALLOWLIST: '456, 123' } }), true);
  assert.equal(canAnalyzeAttachments({ userId: '123', state: {}, env: { HELIUM_ATTACHMENT_ALLOWLIST: '1234' } }), false);
});

test('guild-scoped staff grants cannot cross guild boundaries or gain owner-only rights', () => {
  delete process.env.HELIUM_OWNER_EMAIL;
  delete process.env.HELIUM_OWNER_DISCORD_ID;
  replaceStaffRoleAssignments([{ identityType: 'email', identity: 'mod@example.com', role: 'moderator', level: 'senior', scope: 'guild', guildIds: [GUILD_A] }]);
  const identity = { email: 'mod@example.com', provider: 'google' };
  assert.equal(authorize(identity, PERMISSIONS.CONSOLE_READ, GUILD_A).allowed, true);
  assert.equal(authorize(identity, PERMISSIONS.CONSOLE_READ, GUILD_B).allowed, false);
  assert.equal(authorize(identity, PERMISSIONS.OWNER_MANAGE, GUILD_A).allowed, false);
  assert.deepEqual(getAccessibleGuildIds(identity), [GUILD_A]);
});

test('owner identity is resolved only from environment and high-risk routes are owner-only', () => {
  process.env.HELIUM_OWNER_EMAIL = 'owner@example.com';
  const owner = { email: 'owner@example.com', provider: 'google' };
  assert.equal(authorize(owner, PERMISSIONS.OWNER_MANAGE).allowed, true);
  assert.equal(requiredPermissionForRequest({ method: 'PUT', path: '/api/db/collection/users/abc' }), PERMISSIONS.OWNER_MANAGE);
  assert.equal(requiredPermissionForRequest({ method: 'POST', path: '/api/migrations' }), PERMISSIONS.OWNER_MANAGE);
  assert.equal(requiredPermissionForRequest({ method: 'GET', path: '/api/stats' }), PERMISSIONS.CONSOLE_READ);
  assert.equal(requiredPermissionForRequest({ method: 'GET', path: '/api/audit/logs' }), PERMISSIONS.SENSITIVE_READ);
  assert.equal(requiredPermissionForRequest({ method: 'GET', path: '/api/new-unclassified-route' }), PERMISSIONS.OWNER_MANAGE);
  delete process.env.HELIUM_OWNER_EMAIL;
});
