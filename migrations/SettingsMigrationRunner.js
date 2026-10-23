import { randomUUID } from 'node:crypto';
import { getCollection } from '../database/connection.js';
import {
  DEFAULT_USER_SETTINGS,
  DEFAULT_SERVER_SETTINGS,
  getDefaultUserSettings,
  getDefaultServerSettings,
  getSettingDefaults,
  saveSettingDefaultsToDB,
} from '../managers/StateManager.js';
import { SUPPORTED_MODEL_IDS } from '../modules/config.js';

const BATCH_SIZE = 50;
const MAX_SELECTION = 5_000;
const OVERWRITE_CONFIRMATION = 'OVERWRITE EXPLICIT SETTINGS';
const USER_ID = /^\d{17,20}$/;
const GUILD_ID = /^\d{17,20}$/;
const RUNS = 'migrationRuns';
const SNAPSHOTS = 'migrationSnapshots';

function schemaFor(type) {
  if (type === 'users') return DEFAULT_USER_SETTINGS;
  if (type === 'servers') return DEFAULT_SERVER_SETTINGS;
  throw new TypeError('Setting target must be users or servers.');
}

function idFieldFor(type) {
  return type === 'users' ? 'userId' : 'guildId';
}

function collectionFor(type) {
  return type === 'users' ? 'userSettings' : 'serverSettings';
}

function normalizeIds(values, type) {
  if (values === undefined) return [];
  if (!Array.isArray(values) || values.length > MAX_SELECTION) throw new TypeError(`Selection must be an array of at most ${MAX_SELECTION} IDs.`);
  const pattern = type === 'users' ? USER_ID : GUILD_ID;
  const ids = [...new Set(values.map(value => String(value)))];
  if (ids.some(value => !pattern.test(value))) throw new TypeError(`Every ${type === 'users' ? 'user' : 'guild'} ID must be a 17–20 digit Discord ID.`);
  return ids;
}

function validateValue(type, field, value) {
  const schema = schemaFor(type);
  if (!Object.hasOwn(schema, field)) throw new TypeError(`Unsupported ${type} setting: ${field}`);
  if (field === 'selectedModel') {
    if (typeof value !== 'string' || !SUPPORTED_MODEL_IDS.includes(value)) throw new TypeError('selectedModel must be a registered model ID.');
  } else if (field === 'customPersonality') {
    if (value !== null && (typeof value !== 'string' || value.length > 4_000)) throw new TypeError('customPersonality must be null or a string up to 4000 characters.');
  } else if (field === 'responseFormat') {
    if (!['Normal', 'Embedded'].includes(value)) throw new TypeError('responseFormat must be Normal or Embedded.');
  } else if (field === 'embedColor') {
    if (typeof value !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(value)) throw new TypeError('embedColor must be a #RRGGBB color.');
  } else if (Array.isArray(schema[field])) {
    if (!Array.isArray(value) || value.length > 500 || value.some(item => typeof item !== 'string' || item.length > 100)) throw new TypeError(`${field} must be a string array with at most 500 entries.`);
    return [...new Set(value)];
  } else if (schema[field] === null) {
    if (value !== null && (typeof value !== 'string' || value.length > 4_000)) throw new TypeError(`${field} must be null or a bounded string.`);
  } else if (typeof value !== typeof schema[field]) {
    throw new TypeError(`${field} must be ${typeof schema[field]}.`);
  }
  return value;
}

function normalizeOptions(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Migration options must be an object.');
  const scope = input.scope ?? 'both';
  const mode = input.mode ?? ((input.userIds?.length || input.guildIds?.length) ? 'selected' : 'all');
  if (!['users', 'servers', 'both'].includes(scope)) throw new TypeError('scope must be users, servers, or both.');
  if (!['all', 'selected', 'unset-only', 'future-only'].includes(mode)) throw new TypeError('mode must be all, selected, unset-only, or future-only.');
  if (mode === 'selected' && !input.userIds?.length && !input.guildIds?.length) throw new TypeError('Selected mode requires userIds and/or guildIds.');
  if (scope === 'users' && input.guildIds?.length) throw new TypeError('guildIds cannot be used with scope=users.');
  if (scope === 'servers' && input.userIds?.length) throw new TypeError('userIds cannot be used with scope=servers.');
  if (input.overwriteExisting === true && input.confirmOverwrite !== OVERWRITE_CONFIRMATION) {
    throw new TypeError(`Overwriting explicit settings requires confirmOverwrite="${OVERWRITE_CONFIRMATION}".`);
  }

  const normalized = {
    scope,
    mode,
    dryRun: input.dryRun === true,
    overwriteExisting: input.overwriteExisting === true,
    userIds: normalizeIds(input.userIds, 'users'),
    guildIds: normalizeIds(input.guildIds, 'servers'),
    actor: typeof input.actor === 'string' ? input.actor.slice(0, 320) : 'unknown',
    reason: typeof input.reason === 'string' ? input.reason.trim().slice(0, 500) : '',
    fields: Array.isArray(input.fields) ? [...new Set(input.fields)] : null,
    userFields: Array.isArray(input.userFields) ? [...new Set(input.userFields)] : null,
    serverFields: Array.isArray(input.serverFields) ? [...new Set(input.serverFields)] : null,
    values: input.values && typeof input.values === 'object' && !Array.isArray(input.values) ? input.values : {},
  };

  for (const type of ['users', 'servers']) {
    if (scope !== 'both' && scope !== type) continue;
    const schema = schemaFor(type);
    const requested = normalized[`${type === 'users' ? 'user' : 'server'}Fields`] ?? normalized.fields ?? Object.keys(schema);
    if (requested.length > Object.keys(schema).length || requested.some(field => typeof field !== 'string' || !Object.hasOwn(schema, field))) {
      throw new TypeError(`One or more ${type} fields are not migratable.`);
    }
    normalized[`${type === 'users' ? 'user' : 'server'}Fields`] = [...new Set(requested)];
    const rawValues = normalized.values[type] && typeof normalized.values[type] === 'object' && !Array.isArray(normalized.values[type])
      ? normalized.values[type]
      : normalized.values;
    const values = {};
    for (const field of normalized[`${type === 'users' ? 'user' : 'server'}Fields`]) {
      if (Object.hasOwn(rawValues, field)) values[field] = validateValue(type, field, rawValues[field]);
    }
    normalized.values[type] = values;
  }
  return normalized;
}

function fieldsToApply(type, options) {
  const defaults = type === 'users' ? getDefaultUserSettings() : getDefaultServerSettings();
  const selected = options[`${type === 'users' ? 'user' : 'server'}Fields`] || [];
  return Object.fromEntries(selected.map(field => [field,
    Object.hasOwn(options.values[type] || {}, field)
      ? options.values[type][field]
      : defaults[field],
  ]));
}

function currentVersionFilter(doc, idField) {
  const filter = { [idField]: doc[idField] };
  if (doc.updatedAt instanceof Date) filter.updatedAt = doc.updatedAt;
  else filter.updatedAt = { $exists: false };
  return filter;
}

async function processTarget(type, options, runId = null) {
  const collectionName = collectionFor(type);
  const idField = idFieldFor(type);
  const collection = getCollection(collectionName);
  const targetValues = fieldsToApply(type, options);
  const ids = type === 'users' ? options.userIds : options.guildIds;
  const query = options.mode === 'selected' ? { [idField]: { $in: ids } } : {};
  const cursor = collection.find(query).batchSize(BATCH_SIZE);
  let scanned = 0, eligible = 0, changed = 0, skipped = 0, failed = 0;

  const applyDocument = async (doc) => {
    scanned++;
    const beforeFields = {};
    const setValues = {};
    for (const [field, value] of Object.entries(targetValues)) {
      const hasOwn = Object.hasOwn(doc, field);
      if (hasOwn) beforeFields[field] = { exists: true, value: doc[field] };
      else beforeFields[field] = { exists: false };
      if (options.overwriteExisting || !hasOwn) setValues[field] = value;
    }
    if (Object.keys(setValues).length === 0) { skipped++; return; }
    eligible++;
    if (options.dryRun) { changed++; return; }

    const at = new Date();
    const afterValues = structuredClone(setValues);
    const snapshot = {
      migrationId: runId, type, collectionName, idField, targetId: String(doc[idField]),
      beforeExists: true, beforeFields, afterValues, afterUpdatedAt: at,
      beforeUpdatedAt: doc.updatedAt ?? null, status: 'prepared', createdAt: new Date(),
    };
    const snapResult = await getCollection(SNAPSHOTS).insertOne(snapshot);
    try {
      const result = await collection.updateOne(currentVersionFilter(doc, idField), { $set: { ...setValues, [idField]: doc[idField], updatedAt: at } });
      if (result.matchedCount !== 1) {
        await getCollection(SNAPSHOTS).updateOne({ _id: snapResult.insertedId }, { $set: { status: 'skipped_concurrent_change', completedAt: new Date() } });
        skipped++;
        return;
      }
      await getCollection(SNAPSHOTS).updateOne({ _id: snapResult.insertedId }, { $set: { status: 'applied', completedAt: new Date() } });
      changed++;
    } catch (error) {
      failed++;
      await getCollection(SNAPSHOTS).updateOne({ _id: snapResult.insertedId }, { $set: { status: 'failed', errorCode: String(error.code || 'WRITE_FAILED').slice(0, 80), completedAt: new Date() } }).catch(() => {});
    }
  };

  for await (const doc of cursor) {
    try { await applyDocument(doc); } catch { failed++; }
  }

  // Selected users may not have a settings document yet. Preview those creations
  // without writing, and create rollback snapshots before any actual insert.
  if (options.mode === 'selected') {
    const selectedSet = new Set(ids);
    const existing = await collection.find({ [idField]: { $in: ids } }, { projection: { [idField]: 1 } }).toArray();
    for (const doc of existing) selectedSet.delete(String(doc[idField]));
    for (const targetId of selectedSet) {
      const selectedValues = { ...targetValues };
      // New records have no explicit user choices, so use the requested field
      // values; unrelated fields remain absent and receive fallback defaults.
      if (!Object.keys(selectedValues).length) { skipped++; continue; }
      eligible++;
      if (options.dryRun) { changed++; continue; }
      const record = { [idField]: targetId, ...selectedValues, updatedAt: new Date() };
      const snapshot = {
        migrationId: runId, type, collectionName, idField, targetId,
        beforeExists: false, beforeFields: {}, afterValues: structuredClone(selectedValues), afterUpdatedAt: record.updatedAt,
        beforeUpdatedAt: null, status: 'prepared', createdAt: new Date(),
      };
      const snapResult = await getCollection(SNAPSHOTS).insertOne(snapshot);
      try {
        await collection.insertOne(record);
        await getCollection(SNAPSHOTS).updateOne({ _id: snapResult.insertedId }, { $set: { status: 'applied', completedAt: new Date() } });
        changed++;
      } catch (error) {
        await getCollection(SNAPSHOTS).updateOne({ _id: snapResult.insertedId }, { $set: { status: error.code === 11000 ? 'skipped_concurrent_change' : 'failed', completedAt: new Date() } }).catch(() => {});
        if (error.code === 11000) skipped++; else failed++;
      }
    }
  }
  return { type, collection: collectionName, scanned, eligible, changed, skipped, failed };
}

async function applyFutureDefaults(options, suppliedRunId = null) {
  const current = getSettingDefaults();
  const next = { users: { ...current.users }, servers: { ...current.servers } };
  for (const type of ['users', 'servers']) {
    if (options.scope !== 'both' && options.scope !== type) continue;
    const targetValues = fieldsToApply(type, options);
    for (const [field, value] of Object.entries(targetValues)) next[type][field] = value;
  }
  if (options.dryRun) return { futureDefaults: next, changed: true };
  const previous = getCollection(SNAPSHOTS);
  const runId = suppliedRunId || randomUUID();
  const before = getSettingDefaults();
  await previous.insertOne({ migrationId: runId, type: 'futureDefaults', collectionName: 'settingDefaults', targetId: 'active', beforeExists: true, beforeFields: { users: { exists: true, value: before.users }, servers: { exists: true, value: before.servers } }, afterValues: next, afterUpdatedAt: new Date(), status: 'applied', createdAt: new Date(), completedAt: new Date() });
  await saveSettingDefaultsToDB(next);
  return { futureDefaults: next, migrationId: runId, changed: true };
}

export async function previewSettingsMigration(input = {}) {
  const options = normalizeOptions({ ...input, dryRun: true });
  if (options.mode === 'future-only') return { success: true, ...await applyFutureDefaults(options) };
  const results = [];
  if (options.scope === 'users' || options.scope === 'both') results.push(await processTarget('users', options));
  if (options.scope === 'servers' || options.scope === 'both') results.push(await processTarget('servers', options));
  return { success: true, dryRun: true, options: publicOptions(options), results, totalEligible: results.reduce((n, result) => n + result.eligible, 0) };
}

function publicOptions(options) {
  const { actor, values, ...safe } = options;
  return { ...safe, values: Object.fromEntries(Object.entries(values || {}).map(([type, object]) => [type, Object.keys(object || {})])) };
}

export async function runSettingsMigration(input = {}) {
  const options = normalizeOptions(input);
  if (options.dryRun) return previewSettingsMigration(input);
  if (options.mode === 'future-only') {
    const id = randomUUID();
    const runs = getCollection(RUNS);
    await runs.insertOne({ _id: id, schemaVersion: 1, type: 'settings', mode: options.mode, scope: options.scope, actor: options.actor, reason: options.reason, status: 'running', startedAt: new Date() });
    try {
      const result = await applyFutureDefaults(options, id);
      await runs.updateOne({ _id: id }, { $set: { status: 'completed', completedAt: new Date(), result } });
      return { success: true, migrationId: id, ...result };
    } catch (error) {
      await runs.updateOne({ _id: id }, { $set: { status: 'failed', completedAt: new Date(), error: String(error?.message || error).slice(0, 500) } });
      throw error;
    }
  }
  const migrationId = randomUUID();
  const runs = getCollection(RUNS);
  await runs.insertOne({
    _id: migrationId, schemaVersion: 1, type: 'settings', mode: options.mode, scope: options.scope,
    actor: options.actor, reason: options.reason, options: publicOptions(options),
    status: 'running', startedAt: new Date(), progress: { scanned: 0, changed: 0, failed: 0 },
  });
  try {
    const results = [];
    if (options.scope === 'users' || options.scope === 'both') results.push(await processTarget('users', options, migrationId));
    if (options.scope === 'servers' || options.scope === 'both') results.push(await processTarget('servers', options, migrationId));
    const status = results.some(result => result.failed > 0) ? 'completed_with_errors' : 'completed';
    await runs.updateOne({ _id: migrationId }, { $set: { status, result: results, completedAt: new Date(), progress: {
      scanned: results.reduce((n, result) => n + result.scanned, 0),
      changed: results.reduce((n, result) => n + result.changed, 0),
      failed: results.reduce((n, result) => n + result.failed, 0),
    } } });
    return { success: results.every(result => result.failed === 0), migrationId, status, results };
  } catch (error) {
    await runs.updateOne({ _id: migrationId }, { $set: { status: 'failed', errorCode: String(error.code || 'MIGRATION_FAILED').slice(0, 80), completedAt: new Date() } }).catch(() => {});
    throw error;
  }
}

export async function listSettingsMigrations({ limit = 50 } = {}) {
  const bounded = Math.min(100, Math.max(1, Number.isInteger(Number(limit)) ? Number(limit) : 50));
  return getCollection(RUNS).find({}, { projection: { options: 0, errorDetails: 0 } }).sort({ startedAt: -1 }).limit(bounded).toArray();
}

export async function getSettingsMigration(migrationId) {
  if (typeof migrationId !== 'string' || !/^[0-9a-f-]{36}$/i.test(migrationId)) return null;
  const run = await getCollection(RUNS).findOne({ _id: migrationId }, { projection: { options: 0, errorDetails: 0 } });
  if (!run) return null;
  const counts = await getCollection(SNAPSHOTS).aggregate([
    { $match: { migrationId } },
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]).toArray();
  return { ...run, snapshotCounts: Object.fromEntries(counts.map(item => [item._id, item.count])) };
}

export async function rollbackSettingsMigration(migrationId, actor = 'unknown') {
  if (typeof migrationId !== 'string' || !/^[0-9a-f-]{36}$/i.test(migrationId)) throw new TypeError('Invalid migration ID.');
  const runs = getCollection(RUNS);
  const run = await runs.findOne({ _id: migrationId });
  if (!run) throw new Error('Migration not found.');
  if (run.status === 'rolled_back') return { success: true, migrationId, alreadyRolledBack: true, restored: 0, skipped: 0 };
  const snapshots = getCollection(SNAPSHOTS);
  const cursor = snapshots.find({ migrationId, status: { $in: ['applied', 'prepared'] } }).sort({ createdAt: -1 }).batchSize(BATCH_SIZE);
  let restored = 0, skipped = 0, failed = 0;
  for await (const snap of cursor) {
    try {
      if (snap.type === 'futureDefaults') {
        const current = getSettingDefaults();
        const currentDoc = await getCollection('settingDefaults').findOne({ _id: 'active' });
        const after = snap.afterValues || {};
        const unchanged = JSON.stringify(current.users) === JSON.stringify(after.users) && JSON.stringify(current.servers) === JSON.stringify(after.servers);
        if (!unchanged) { skipped++; await snapshots.updateOne({ _id: snap._id }, { $set: { status: 'rollback_skipped_concurrent_change' } }); continue; }
        const before = { users: snap.beforeFields.users.value, servers: snap.beforeFields.servers.value };
        await saveSettingDefaultsToDB(before);
        await snapshots.updateOne({ _id: snap._id }, { $set: { status: 'rolled_back', rolledBackAt: new Date(), rolledBackBy: actor } });
        restored++;
        continue;
      }
      const collection = getCollection(snap.collectionName);
      const idFilter = { [snap.idField]: snap.targetId };
      const current = await collection.findOne(idFilter);
      if (!current || !(current.updatedAt instanceof Date) || current.updatedAt.getTime() !== new Date(snap.afterUpdatedAt).getTime()) {
        skipped++;
        await snapshots.updateOne({ _id: snap._id }, { $set: { status: 'rollback_skipped_concurrent_change' } });
        continue;
      }
      if (!snap.beforeExists) {
        const deletion = await collection.deleteOne({ ...idFilter, updatedAt: current.updatedAt });
        if (deletion.deletedCount !== 1) { skipped++; continue; }
      } else {
        const set = { updatedAt: new Date() };
        const unset = {};
        for (const [field, before] of Object.entries(snap.beforeFields || {})) {
          if (before.exists) set[field] = before.value;
          else unset[field] = '';
        }
        const update = { $set: set };
        if (Object.keys(unset).length) update.$unset = unset;
        const result = await collection.updateOne({ ...idFilter, updatedAt: current.updatedAt }, update);
        if (result.matchedCount !== 1) { skipped++; continue; }
      }
      await snapshots.updateOne({ _id: snap._id }, { $set: { status: 'rolled_back', rolledBackAt: new Date(), rolledBackBy: actor } });
      restored++;
    } catch {
      failed++;
    }
  }
  const status = failed ? 'rollback_completed_with_errors' : 'rolled_back';
  await runs.updateOne({ _id: migrationId }, { $set: { status, rolledBackAt: new Date(), rolledBackBy: actor, rollbackResult: { restored, skipped, failed } } });
  return { success: failed === 0, migrationId, status, restored, skipped, failed };
}

export const MIGRATION_SCHEMA = Object.freeze({
  userFields: Object.keys(DEFAULT_USER_SETTINGS),
  serverFields: Object.keys(DEFAULT_SERVER_SETTINGS),
  modes: ['all', 'selected', 'unset-only', 'future-only'],
  scopes: ['users', 'servers', 'both'],
  overwriteConfirmation: OVERWRITE_CONFIRMATION,
  notes: [
    'Existing fields, including explicit false values, are preserved unless overwriteExisting is explicitly confirmed.',
    'New-user defaults are managed separately from existing user/server records.',
    'Rollback uses updatedAt compare-and-swap and skips records changed after the migration.',
  ],
});
