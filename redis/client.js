const Redis = require("ioredis");

const redis = new Redis({
  host: process.env.REDIS_HOST || "localhost",
  port: process.env.REDIS_PORT || 6379,
  connectTimeout: 5000,
  maxRetriesPerRequest: null,
  lazyConnect: true,
  retryStrategy(times) {
    if (times > 10) return null; // stop retrying after 10 attempts
    return Math.min(times * 500, 5000);
  },
});

let isRedisConnected = false;

redis.on("connect", () => {
  isRedisConnected = true;
  console.log("Chat-service: Connected to Redis");
});

redis.on("error", (error) => {
  isRedisConnected = false;
  // Suppress repetitive logs — only log once on first error
});

redis.on("close", () => {
  isRedisConnected = false;
});

redis.on("end", () => {
  isRedisConnected = false;
  console.warn("Chat-service: Redis connection ended, running without Redis");
});

// Try to connect, but don't crash if unavailable
redis.connect().catch((err) => {
  console.warn("Chat-service: Redis unavailable, running without caching:", err.message);
});

function isConnected() {
  return isRedisConnected;
}

module.exports = { redis, isConnected };
