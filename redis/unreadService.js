const { redis, isConnected } = require("./client");

/**
 * Redis-primary unread count service.
 * Redis hash per user: unread:{userId} → { conversationId: count, ... }
 * DB is a periodic snapshot only (flushed every 5 min).
 */

async function incrementUnread(userId, conversationId) {
  if (!isConnected()) return;
  await redis.hincrby(`unread:${userId}`, String(conversationId), 1);
}

async function incrementUnreadBulk(userIds, conversationId) {
  if (!isConnected()) return;
  const pipeline = redis.pipeline();
  userIds.forEach((uid) => {
    pipeline.hincrby(`unread:${uid}`, String(conversationId), 1);
  });
  await pipeline.exec();
}

async function resetUnread(userId, conversationId) {
  if (!isConnected()) return;
  await redis.hset(`unread:${userId}`, String(conversationId), 0);
}

async function getAllUnreads(userId) {
  if (!isConnected()) return {};
  const data = await redis.hgetall(`unread:${userId}`);
  // Convert string values to numbers
  const result = {};
  for (const [key, val] of Object.entries(data)) {
    const count = parseInt(val, 10);
    if (count > 0) {
      result[key] = count;
    }
  }
  return result;
}

async function getUnread(userId, conversationId) {
  if (!isConnected()) return 0;
  const val = await redis.hget(`unread:${userId}`, String(conversationId));
  return val ? parseInt(val, 10) : 0;
}

async function removeConversationUnread(userId, conversationId) {
  if (!isConnected()) return;
  await redis.hdel(`unread:${userId}`, String(conversationId));
}

/**
 * Hydrate Redis from DB for a given user.
 * Called on login when Redis has no data for this user.
 */
async function hydrateFromDb(userId, participantRows) {
  if (!isConnected()) return;
  const pipeline = redis.pipeline();
  participantRows.forEach((row) => {
    if (row.unread_count > 0) {
      pipeline.hset(`unread:${userId}`, String(row.conversation_id), row.unread_count);
    }
  });
  await pipeline.exec();
}

/**
 * Get all unread data for a user for flushing to DB.
 * Returns { conversationId: count } map.
 */
async function getUnreadsForFlush(userId) {
  return getAllUnreads(userId);
}

module.exports = {
  incrementUnread,
  incrementUnreadBulk,
  resetUnread,
  getAllUnreads,
  getUnread,
  removeConversationUnread,
  hydrateFromDb,
  getUnreadsForFlush,
};
