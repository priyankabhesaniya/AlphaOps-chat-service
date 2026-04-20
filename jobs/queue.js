const Queue = require("bull");

const REDIS_URL = process.env.REDIS_URL || `redis://${process.env.REDIS_HOST || "127.0.0.1"}:${process.env.REDIS_PORT || 6379}`;

let fanoutQueue, maintenanceQueue;
let bullAvailable = false;

try {
  fanoutQueue = new Queue("chat-fanout", REDIS_URL, {
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 2000 },
      removeOnComplete: 100,
      removeOnFail: 500,
    },
  });

  maintenanceQueue = new Queue("chat-maintenance", REDIS_URL, {
    defaultJobOptions: {
      attempts: 2,
      backoff: { type: "fixed", delay: 5000 },
      removeOnComplete: 50,
      removeOnFail: 200,
    },
  });

  fanoutQueue.on("error", (err) => {
    if (bullAvailable) console.error("[chat-fanout] Queue error:", err.message);
  });
  maintenanceQueue.on("error", (err) => {
    if (bullAvailable) console.error("[chat-maintenance] Queue error:", err.message);
  });
  fanoutQueue.on("ready", () => { bullAvailable = true; });

  fanoutQueue.on("failed", (job, err) => {
    console.error(`[chat-fanout] Job ${job.id} failed (attempt ${job.attemptsMade}):`, err.message);
  });
  fanoutQueue.on("stalled", (jobId) => {
    console.warn(`[chat-fanout] Job ${jobId} stalled`);
  });
  maintenanceQueue.on("failed", (job, err) => {
    console.error(`[chat-maintenance] Job ${job.id} failed:`, err.message);
  });
} catch (err) {
  console.warn("Chat-service: Bull queues unavailable (Redis down):", err.message);
}

// --- Producers (no-op when Redis unavailable) ---

async function addMessageFanoutJob(data) {
  if (!fanoutQueue || !bullAvailable) return null;
  return fanoutQueue.add("messageFanout", data, { priority: 1 });
}

async function addUnreadFlushJob() {
  if (!maintenanceQueue || !bullAvailable) return null;
  return maintenanceQueue.add("unreadFlush", {}, {
    repeat: { every: 5 * 60 * 1000 },
    jobId: "unread-flush-repeatable",
  });
}

module.exports = {
  fanoutQueue,
  maintenanceQueue,
  addMessageFanoutJob,
  addUnreadFlushJob,
};
