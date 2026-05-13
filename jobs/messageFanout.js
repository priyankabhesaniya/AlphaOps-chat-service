const { Conversation, ConversationParticipant, Message, MessageMention, MessageSearchIndex } = require("../models");
const { getParticipantIds, getCachedUser, getHydratedUser } = require("../redis/cacheService");
const { isConnected, redis } = require("../redis/client");
const axios = require("axios");
const { toPlainText } = require("../utils/richText");
const { Op } = require("sequelize");

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
    file_name,
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

  const recipients = participantIds.filter((id) => Number(id) !== Number(sender_id));

  let senderName = null;
  try {
    const senderUser = await getHydratedUser(sender_id, org_id);
    if (senderUser) {
      senderName = senderUser.name || senderUser.full_name || senderUser.first_name || null;
    }
  } catch (_) { /* non-critical */ }


  const uidUnreadMap = {};
  if (recipients.length > 0) {
    if (isConnected()) {
      const dedupePipeline = redis.pipeline();
      recipients.forEach((uid) => {
        dedupePipeline.set(
          `unread:applied:${message_id}:${uid}`,
          "1",
          "EX",
          60 * 60 * 24 * 7,
          "NX"
        );
      });
      const dedupeResults = await dedupePipeline.exec().catch(() => []);

      const recipientsToIncrement = [];
      recipients.forEach((uid, i) => {
        const [, dedupeSetResult] = dedupeResults[i] || [];
        if (dedupeSetResult === "OK") {
          recipientsToIncrement.push(uid);
        }
      });

      if (recipientsToIncrement.length > 0) {
        // Use pipeline HINCRBY which returns the new value after increment.
        const pipeline = redis.pipeline();
        recipientsToIncrement.forEach((uid) => {
          pipeline.hincrby(`unread:${uid}`, String(conversation_id), 1);
        });
        const results = await pipeline.exec().catch(() => []);
        recipientsToIncrement.forEach((uid, i) => {
          const [err, count] = results[i] || [null, null];
          uidUnreadMap[String(uid)] = err ? null : Number(count);
        });
      }

      // For recipients skipped by idempotency guard, fetch current absolute count so
      // clients still receive an authoritative value.
      const recipientsToFetch = recipients.filter((uid) => !Object.prototype.hasOwnProperty.call(uidUnreadMap, String(uid)));
      if (recipientsToFetch.length > 0) {
        const fetchPipeline = redis.pipeline();
        recipientsToFetch.forEach((uid) => {
          fetchPipeline.hget(`unread:${uid}`, String(conversation_id));
        });
        const fetchResults = await fetchPipeline.exec().catch(() => []);
        recipientsToFetch.forEach((uid, i) => {
          const [err, count] = fetchResults[i] || [null, null];
          uidUnreadMap[String(uid)] = err ? null : Number(count || 0);
        });
      }
    } else {
      // Redis down — write directly to DB and fetch absolute unread counts.
      // Emitting absolute unread_count keeps client updates idempotent.
      try {
        await ConversationParticipant.increment("unread_count", {
          by: 1,
          where: { conversation_id, user_id: recipients, is_active: 1 },
        });

        const participantUnreadRows = await ConversationParticipant.findAll({
          where: { conversation_id, user_id: recipients, is_active: 1 },
          attributes: ["user_id", "unread_count"],
          raw: true,
        });
        participantUnreadRows.forEach((row) => {
          uidUnreadMap[String(row.user_id)] = Number(row.unread_count || 0);
        });
      } catch (err) {
        console.error("[fanout] DB unread increment failed:", err.message);
      }
    }

    for (const uid of recipients) {
      const newCount = uidUnreadMap[String(uid)];
      // Always emit absolute unread_count when available to avoid duplicate client increments.
      if (!Number.isFinite(newCount)) continue;
      const payload = { conversation_id, unread_count: newCount };
      // Adapter-safe: same pattern as conversation:created — local sockets map misses remote nodes.
      global._io?.to?.(`user:${uid}`)?.emit?.("unread:update", payload);
    }
  }

  // 4. Update conversation denormalized fields
  const plainContent = toPlainText(content || "");
  const preview =
    Number(kind) === 1
      ? (plainContent ? plainContent.substring(0, 200) : null)
      : Number(kind) === 2
        ? (file_name || null)
        : (plainContent ? plainContent.substring(0, 200) : null);
  await Conversation.update(
    {
      last_message_id: message_id,
      last_message_at: new Date(),
      last_message_preview: preview,
      last_message_sender_id: sender_id,
    },
    { where: { id: conversation_id } }
  );

  // 4.1 Unhide conversations that were soft-deleted "for me"
  // If a user hid the conversation, it should reappear automatically when a new message arrives.
  // We also emit conversation:created so clients that removed it can re-add instantly.
  if (recipients.length > 0) {
    try {
      const hiddenRows = await ConversationParticipant.findAll({
        where: {
          conversation_id,
          user_id: recipients,
          is_active: 1,
          hidden_last_message_id: { [Op.not]: null, [Op.lt]: message_id },
        },
        attributes: ["user_id", "role", "is_favorite", "is_muted"],
        raw: true,
      });

      if (hiddenRows.length > 0) {
        const hiddenUserIds = hiddenRows.map((r) => r.user_id);
        await ConversationParticipant.update(
          // IMPORTANT: Do NOT reset hidden_last_message_id.
          // It is the permanent per-user history cutoff (messages <= this remain hidden forever).
          // We only clear hidden_at so the conversation becomes visible again.
          { hidden_at: null },
          { where: { conversation_id, user_id: hiddenUserIds } }
        );

        const conv = await Conversation.findOne({
          where: { id: conversation_id, is_deleted: 0 },
          attributes: [
            "id",
            "org_id",
            "type",
            "title",
            "avatar_url",
            "group_type",
            "is_read_only",
            "allow_read_receipts",
            "last_message_id",
            "last_message_at",
            "last_message_preview",
            "last_message_sender_id",
            "created_by",
            "created_at",
          ],
          raw: true,
        });

        if (conv) {
          const senders = new Set([conv.last_message_sender_id, sender_id].filter(Boolean).map(String));
          const lastSender = conv.last_message_sender_id
            ? await getCachedUser(conv.last_message_sender_id).catch(() => null)
            : null;

          for (const row of hiddenRows) {
            const uid = row.user_id;

            let title = conv.title;
            let avatarUrl = conv.avatar_url;
            let otherUserId = null;
            let otherUser = null;

            if (Number(conv.type) === 1) {
              otherUserId = participantIds.find((id) => String(id) !== String(uid)) || null;
              if (otherUserId) {
                otherUser = await getHydratedUser(otherUserId, org_id);
                title = otherUser?.name || otherUser?.full_name || otherUser?.first_name || `User ${otherUserId}`;
                avatarUrl = otherUser?.avatar_url || null;
              } else {
                title = "Chat";
                avatarUrl = null;
              }
            }

            const payload = {
              id: conv.id,
              type: conv.type,
              title,
              avatar_url: avatarUrl,
              group_type: conv.group_type,
              is_read_only: conv.is_read_only,
              allow_read_receipts: conv.allow_read_receipts,
              last_message_id: conv.last_message_id,
              last_message_at: conv.last_message_at ? new Date(conv.last_message_at).toISOString() : null,
              last_message_preview: conv.last_message_preview,
              last_message_sender_id: conv.last_message_sender_id,
              created_by: conv.created_by,
              created_at: conv.created_at ? new Date(conv.created_at).toISOString() : null,
              role: row.role,
              is_favorite: row.is_favorite,
              is_muted: row.is_muted,
              last_read_message_id: null,
              unread_count: uidUnreadMap[String(uid)] ?? null,
              last_message_sender: lastSender || null,
              other_user_id: otherUserId,
              other_user: otherUser || null,
              participant_count: participantIds.length,
              members: participantIds,
            };

            // Adapter-safe: emit to per-user room (works across instances)
            global._io?.to?.(`user:${uid}`)?.emit?.("conversation:created", payload);
          }
        }
      }
    } catch (err) {
      console.error("[fanout] unhide failed:", err.message);
    }
  }

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
  if (Number(kind) === 1 && plainContent) {
    await MessageSearchIndex.create({
      message_id,
      conversation_id,
      org_id,
      sender_id,
      content: plainContent,
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

  // 9. Emit conversation:updated to all participants (adapter-safe)
  for (const uid of participantIds) {
    global._io?.to?.(`user:${uid}`)?.emit?.("conversation:updated", {
      conversation_id,
      last_message_id: message_id,
      last_message_at: new Date().toISOString(),
      last_message_preview: preview,
      last_message_sender_id: sender_id,
    });
  }
}

module.exports = processMessageFanout;
