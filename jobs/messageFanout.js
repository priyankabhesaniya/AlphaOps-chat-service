const { Conversation, ConversationParticipant, Message, MessageMention, MessageSearchIndex } = require("../models");
const { getParticipantIds, getCachedUser } = require("../redis/cacheService");
const { incrementUnreadBulk, isConnected: redisConnected } = require("../redis/unreadService");
const { userSockets } = require("../socket/userSocketStore");
const { isConnected } = require("../redis/client");
const axios = require("axios");

const NOTIFICATION_SERVICE_URL = process.env.NOTIFICATION_SERVICE_URL || "http://localhost:3008";

/**
 * Async fan-out processor for new messages.
 * Runs after the message has been persisted and ACKed to sender.
 *
 * Steps:
 * 1. Get participant list
 * 2. Increment unread counts in Redis (bulk)
 * 3. Emit unread:update to connected participants
 * 4. Update conversation denormalized fields
 * 5. Increment thread reply count (if thread)
 * 6. Bulk-insert mentions
 * 7. Populate search index
 * 8. Send FCM push to offline participants
 * 9. Emit conversation:updated to all participants
 */

async function processMessageFanout(job) {
  const {
    message_id,
    conversation_id,
    org_id,
    sender_id,
    content,
    kind,
    parent_message_id,
    mentions,
  } = job.data;

  // 1. Get participant IDs
  let participantIds = await getParticipantIds(conversation_id);
  if (!participantIds || participantIds.length === 0) {
    const rows = await ConversationParticipant.findAll({
      where: { conversation_id, is_active: 1 },
      attributes: ["user_id"],
      raw: true,
    });
    participantIds = rows.map((r) => r.user_id);
  }

  // Exclude sender from unread recipients
  const recipients = participantIds.filter((id) => Number(id) !== Number(sender_id));

  // Resolve sender name for notification payload (best-effort from Redis cache)
  let senderName = null;
  try {
    const senderUser = await getCachedUser(sender_id);
    if (senderUser) {
      senderName = senderUser.name || senderUser.full_name || senderUser.first_name || null;
    }
  } catch (_) { /* non-critical */ }

  // 2. Increment unread counts in Redis (bulk pipeline).
  // Falls back to direct DB increment when Redis is unavailable so counts
  // are always updated regardless of Redis availability.
  if (recipients.length > 0) {
    if (isConnected()) {
      await incrementUnreadBulk(recipients, conversation_id);
    } else {
      // Redis down — write directly to DB
      try {
        await ConversationParticipant.increment("unread_count", {
          by: 1,
          where: { conversation_id, user_id: recipients, is_active: 1 },
        });
      } catch (err) {
        console.error("[fanout] DB unread increment failed:", err.message);
      }
    }
  }

  // 3. Emit unread:update to connected recipients
  for (const uid of recipients) {
    const sockets = userSockets.get(String(uid));
    if (sockets && sockets.size > 0) {
      for (const socketId of sockets) {
        const socketInstance = global._io?.sockets?.sockets?.get(socketId);
        if (socketInstance) {
          socketInstance.emit("unread:update", {
            conversation_id,
            increment: 1,
          });
        }
      }
    }
  }

  // 4. Update conversation denormalized fields
  const preview = content ? content.substring(0, 200) : null;
  await Conversation.update(
    {
      last_message_id: message_id,
      last_message_at: new Date(),
      last_message_preview: preview,
      last_message_sender_id: sender_id,
    },
    { where: { id: conversation_id } }
  );

  // 5. Thread reply count increment
  if (parent_message_id) {
    await Message.increment("thread_reply_count", {
      by: 1,
      where: { id: parent_message_id, conversation_id },
    });
  }

  // 6. Bulk-insert mentions
  if (mentions && mentions.length > 0) {
    const mentionRows = mentions.map((m) => ({
      message_id,
      conversation_id,
      mentioned_user_id: m.user_id || null,
      mention_type: m.type === "all" ? 2 : 1,
      org_id,
      created_at: new Date(),
    }));
    await MessageMention.bulkCreate(mentionRows, { ignoreDuplicates: true });
  }

  // 7. Populate search index (text messages only)
  if (kind === 1 && content) {
    await MessageSearchIndex.create({
      message_id,
      conversation_id,
      org_id,
      sender_id,
      content,
      created_at: new Date(),
    });
  }

  // 8. Push notifications via notification-service.
  // Send to recipients regardless of online status so browser FCM tests work consistently.
  const notifyCandidateUserIds = recipients;

  if (notifyCandidateUserIds.length > 0) {
    try {
      // Check muted participants
      const mutedRows = await ConversationParticipant.findAll({
        where: { conversation_id, user_id: notifyCandidateUserIds, is_muted: 1, is_active: 1 },
        attributes: ["user_id"],
        raw: true,
      });
      const mutedSet = new Set(mutedRows.map((r) => r.user_id));
      const notifyUserIds = notifyCandidateUserIds.filter((uid) => !mutedSet.has(uid));

      if (notifyUserIds.length > 0) {
        const notification = {
          type: "chat_message",
          message: preview || (kind === 2 ? "Sent a file" : "New message"),
          sender_name: senderName || "Someone",
          sender_id: String(sender_id),
          data: JSON.stringify({ conversation_id, message_id }),
          timestamp: new Date().toISOString(),
        };

        await axios
          .post(
            `${NOTIFICATION_SERVICE_URL}/notifications/send`,
            {
              userIds: notifyUserIds,
              notification,
            },
            { timeout: 5000 }
          )
          .catch((err) => {
            console.error("Notification-service send failed:", err.message);
          });
      }
    } catch (err) {
      console.error("Notification check failed:", err.message);
    }
  }

  // 9. Emit conversation:updated to all participant sockets
  for (const uid of participantIds) {
    const sockets = userSockets.get(String(uid));
    if (sockets && sockets.size > 0) {
      for (const socketId of sockets) {
        const socketInstance = global._io?.sockets?.sockets?.get(socketId);
        if (socketInstance) {
          socketInstance.emit("conversation:updated", {
            conversation_id,
            last_message_id: message_id,
            last_message_at: new Date().toISOString(),
            last_message_preview: preview,
            last_message_sender_id: sender_id,
          });
        }
      }
    }
  }
}

module.exports = processMessageFanout;
