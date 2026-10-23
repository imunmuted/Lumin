/** Lightweight lookups retained after disabling the legacy vector-memory pipeline. */
import { Logger } from '../../core/Logger.js';
import { COLLECTIONS, getCollection } from '../connection.js';
const logger = Logger.get('ContextLookups');

export async function getBirthday(userId) {
  try { const doc = await getCollection(COLLECTIONS.BIRTHDAYS).findOne({ userId }); return doc ? { month: doc.month, day: doc.day, name: doc.name } : null; }
  catch (error) { logger.error('Error getting birthday', error); return null; }
}
export async function getUserReminders(userId) {
  try { return await getCollection(COLLECTIONS.REMINDERS).find({ userId, active: true }).toArray(); }
  catch (error) { logger.error('Error getting user reminders', error); return []; }
}
export async function getComplimentCount(userId) {
  try { const doc = await getCollection(COLLECTIONS.COMPLIMENTS).findOne({ userId }); return doc?.count ?? 0; }
  catch (error) { logger.error('Error getting compliment count', error); return 0; }
}
export async function getUserDailyQuote(userId) {
  try { const doc = await getCollection(COLLECTIONS.DAILY_QUOTES).findOne({ userId }); return doc ? { active: doc.active, category: doc.category, time: doc.time } : null; }
  catch (error) { logger.error('Error getting daily quote', error); return null; }
}
