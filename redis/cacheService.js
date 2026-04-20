const { redis, isConnected } = require("./client");
const { getUsersFromDb } = require("../utils/getUsersFromDb");

const PRESENCE_TTL = 30;
const TYPING_TTL = 3;
const USER_CACHE_TTL = 3600; // 1 hour
const PARTICIPANT_CACHE_TTL = 600; // 10 min
const IDEMPOTENCY_TTL = 300; // 5 min

// --- Presence ---

async function setPresence(orgId, userId) {
  if (!isConnected()) return;
  await redis.set(`presence:${orgId}:${userId}`, "1", "EX", PRESENCE_TTL);
}

async function getPresence(orgId, userId) {
  if (!isConnected()) return false;
  const val = await redis.get(`presence:${orgId}:${userId}`);
  return !!val;
}

async function removePresence(orgId, userId) {
  if (!isConnected()) return;
  await redis.del(`presence:${orgId}:${userId}`);
}

async function getOnlineUsers(orgId, userIds) {
  if (!isConnected()) return [];
  const pipeline = redis.pipeline();
  userIds.forEach((uid) => pipeline.get(`presence:${orgId}:${uid}`));
  const results = await pipeline.exec();
  return userIds.filter((_, i) => results[i] && results[i][1]);
}

// --- Typing ---

async function setTyping(conversationId, userId) {
  if (!isConnected()) return;
  await redis.set(`typing:${conversationId}:${userId}`, "1", "EX", TYPING_TTL);
}

async function removeTyping(conversationId, userId) {
  if (!isConnected()) return;
  await redis.del(`typing:${conversationId}:${userId}`);
}

// --- Participants cache ---

async function setParticipantIds(conversationId, userIds) {
  if (!isConnected()) return;
  const key = `conv:participants:${conversationId}`;
  await redis.set(key, JSON.stringify(userIds), "EX", PARTICIPANT_CACHE_TTL);
}

async function getParticipantIds(conversationId) {
  if (!isConnected()) return null;
  const val = await redis.get(`conv:participants:${conversationId}`);
  return val ? JSON.parse(val) : null;
}

async function invalidateParticipants(conversationId) {
  if (!isConnected()) return;
  await redis.del(`conv:participants:${conversationId}`);
}

// --- User cache ---

async function setCachedUser(userId, userData) {
  if (!isConnected()) return;
  await redis.set(`user:${userId}`, JSON.stringify(userData), "EX", USER_CACHE_TTL);
}

async function getCachedUser(userId) {
  if (!isConnected()) return null;
  const val = await redis.get(`user:${userId}`);
  return val ? JSON.parse(val) : null;
}

async function getCachedUsers(userIds) {
  if (!userIds || !userIds.length) return {};

  // Try Redis first
  if (isConnected()) {
    const pipeline = redis.pipeline();
    userIds.forEach((uid) => pipeline.get(`user:${uid}`));
    const results = await pipeline.exec();
    const map = {};
    const missingIds = [];
    userIds.forEach((uid, i) => {
      if (results[i] && results[i][1]) {
        map[uid] = JSON.parse(results[i][1]);
      } else {
        missingIds.push(uid);
      }
    });
    // Fetch missing from DB and backfill cache
    if (missingIds.length > 0) {
      const dbUsers = await getUsersFromDb(missingIds);
      for (const [id, user] of Object.entries(dbUsers)) {
        map[id] = user;
        setCachedUser(id, user).catch(() => {});
      }
    }
    return map;
  }

  // Redis down — fetch all from DB
  return getUsersFromDb(userIds);
}

// --- Idempotency ---

async function setIdempotencyKey(clientMessageId, messageId) {
  if (!isConnected()) return;
  await redis.set(`idem:${clientMessageId}`, String(messageId), "EX", IDEMPOTENCY_TTL);
}

async function getIdempotencyKey(clientMessageId) {
  if (!isConnected()) return null;
  return redis.get(`idem:${clientMessageId}`);
}

// --- Rate Limiting ---

async function checkRateLimit(key, maxCount, windowSeconds) {
  if (!isConnected()) return true; // allow if Redis down
  const current = await redis.incr(key);
  if (current === 1) {
    await redis.expire(key, windowSeconds);
  }
  return current <= maxCount;
}

module.exports = {
  setPresence,
  getPresence,
  removePresence,
  getOnlineUsers,
  setTyping,
  removeTyping,
  setParticipantIds,
  getParticipantIds,
  invalidateParticipants,
  setCachedUser,
  getCachedUser,
  getCachedUsers,
  setIdempotencyKey,
  getIdempotencyKey,
  checkRateLimit,
};
