const { Message, Conversation, ConversationParticipant, MessageReaction, MessageEdit, MessageDeletion } = require("../models");
const {
  getIdempotencyKey,
  setIdempotencyKey,
  getConversationParticipantIds,
  checkRateLimit,
  addMessageDelivery,
  getMessageDeliveries,
  getHydratedUser,
  invalidateParticipants,
  setParticipantIds,
  getOnlineUsers,
} = require("../redis/cacheService");
const { addMessageFanoutJob } = require("../jobs/queue");
const processMessageFanout = require("../jobs/messageFanout");
const { sanitizeRichText, toPlainText } = require("../utils/richText");
const { validateChatAttachmentPayload } = require("../utils/chatAttachmentRules");
const { getUserSockets } = require("./userSocketStore");
const { Op } = require("sequelize");

const MESSAGE_KIND = { TEXT: 1, FILE: 2, SYSTEM: 3 };

async function joinUsersToConversationRoomFromSocket(io, conversationId, userIds) {
  if (!io || !Array.isArray(userIds) || userIds.length === 0) return;
  const adapter = io.of("/").adapter;

  for (const uid of userIds) {
    const sockets = getUserSockets(uid);
    for (const socketId of sockets) {
      const socket = io.sockets.sockets.get(socketId);
      if (socket) {
        socket.join(`conv:${conversationId}`);
      } else if (typeof adapter.remoteJoin === "function") {
        try {
          await adapter.remoteJoin(socketId, `conv:${conversationId}`);
        } catch (_err) {
          // best effort
        }
      }
    }
  }
}

async function activatePendingDmRecipientIfNeeded(io, { conversation_id, orgId, senderId, convType }) {
  if (Number(convType) !== 1) return;

  const pending = await ConversationParticipant.findOne({
    where: {
      conversation_id,
      org_id: orgId,
      is_active: 0,
      left_at: null,
    },
    attributes: ["user_id"],
    raw: true,
  });

  if (!pending?.user_id) return;
  if (String(pending.user_id) === String(senderId)) return;

  await ConversationParticipant.update(
    { is_active: 1, joined_at: new Date() },
    { where: { conversation_id, org_id: orgId, user_id: pending.user_id } }
  );
  await invalidateParticipants(conversation_id);
  const ids = await getConversationParticipantIds(conversation_id, orgId);
  await setParticipantIds(conversation_id, ids);
  await joinUsersToConversationRoomFromSocket(io, conversation_id, [pending.user_id]);

  const convRow = await Conversation.findOne({
    where: { id: conversation_id, org_id: orgId, is_deleted: 0 },
    attributes: [
      "id", "type", "title", "avatar_url", "group_type", "is_read_only", "allow_read_receipts",
      "last_message_id", "last_message_at", "last_message_preview", "last_message_sender_id",
      "created_by", "created_at",
    ],
    raw: true,
  });
  if (!convRow) return;

  const otherId = pending.user_id;
  const otherUser = await getHydratedUser(otherId, orgId).catch(() => null);
  const onlineIds = await getOnlineUsers(orgId, [otherId]).catch(() => []);
  const onlineSet = new Set(onlineIds.map(String));
  const hydratedOther = otherUser
    ? { ...otherUser, is_online: onlineSet.has(String(otherId)) }
    : null;
  const lastSender = convRow.last_message_sender_id
    ? await getHydratedUser(convRow.last_message_sender_id, orgId).catch(() => null)
    : null;

  const payload = {
    id: convRow.id,
    type: convRow.type,
    title: hydratedOther?.name || hydratedOther?.full_name || hydratedOther?.first_name || `User ${otherId}`,
    avatar_url: hydratedOther?.avatar_url || null,
    group_type: convRow.group_type,
    is_read_only: convRow.is_read_only,
    allow_read_receipts: convRow.allow_read_receipts,
    last_message_id: convRow.last_message_id,
    last_message_at: convRow.last_message_at ? new Date(convRow.last_message_at).toISOString() : null,
    last_message_preview: convRow.last_message_preview,
    last_message_sender_id: convRow.last_message_sender_id,
    created_by: convRow.created_by,
    created_at: convRow.created_at ? new Date(convRow.created_at).toISOString() : null,
    role: 3,
    is_favorite: 0,
    is_muted: 0,
    last_read_message_id: null,
    unread_count: 0,
    other_user_id: otherId,
    other_user: hydratedOther,
    participant_count: ids.length,
    members: ids,
    last_message_sender: lastSender || null,
  };

  await emitConversationCreatedToUser(io, pending.user_id, payload);
}

async function collectDeliveredRecipients(io, conversationId, senderId) {
  const room = `conv:${conversationId}`;
  const socketIds = await io.in(room).allSockets();
  const deliveredMap = new Map();

  for (const socketId of socketIds) {
    const recipientSocket = io.sockets.sockets.get(socketId);
    if (!recipientSocket) continue;
    const recipientId = recipientSocket.userId;
    if (!recipientId || String(recipientId) === String(senderId)) continue;
    if (!deliveredMap.has(String(recipientId))) {
      deliveredMap.set(String(recipientId), {
        user_id: recipientId,
        delivered_at: new Date().toISOString(),
      });
    }
  }

  return Array.from(deliveredMap.values());
}

async function sendDeliveredEvent(io, conversationId, messageId, recipientCount) {
  // Always fetch the full persisted delivery list so the event reflects cumulative state
  const persistedDeliveries = await getMessageDeliveries(messageId);
  const deliveredUserIds = persistedDeliveries.map((d) => d.user_id);
  const deliveredToAll = recipientCount > 0 && deliveredUserIds.length >= recipientCount;
  const message = await Message.findByPk(messageId, { attributes: ["client_message_id"], raw: true });

  io.to(`conv:${conversationId}`).emit("message:delivered", {
    conversation_id: conversationId,
    message_id: messageId,
    client_message_id: message?.client_message_id || null,
    delivered_to: persistedDeliveries,
    delivered_to_all: deliveredToAll,
    delivered_count: deliveredUserIds.length,
    recipient_count: recipientCount,
  });
}

async function emitConversationCreatedToUser(io, userId, payload) {
  // Adapter-safe: per-user room works across instances
  io?.to?.(`user:${userId}`)?.emit?.("conversation:created", payload);
}

function setupMessageHandler(io, socket) {
  const { userId, orgId } = socket;

  // --- Send message ---
  socket.on("message:send", async (data, ack) => {
    try {
      const {
        conversation_id,
        content,
        kind = MESSAGE_KIND.TEXT,
        file_reference_id,
        file_name,
        file_type,
        file_size_bytes,
        reply_to_message_id,
        parent_message_id,
        forwarded_from_id,
        mentions,
        client_message_id,
      } = data;

      if (!conversation_id) {
        return ack?.({ error: "conversation_id is required" });
      }

      // Read-only group enforcement (backend source of truth)
      const conv = await Conversation.findOne({
        where: { id: conversation_id, org_id: orgId, is_deleted: 0 },
        attributes: ["id", "type", "is_read_only"],
        raw: true,
      });
      if (!conv) {
        return ack?.({ error: "Conversation not found" });
      }

      await activatePendingDmRecipientIfNeeded(io, {
        conversation_id,
        orgId,
        senderId: userId,
        convType: conv.type,
      });

      // Participant enforcement (left/kicked users can't send)
      const membership = await ConversationParticipant.findOne({
        where: { conversation_id, org_id: orgId, user_id: userId, is_active: 1 },
        attributes: ["role"],
        raw: true,
      });
      if (!membership) {
        return ack?.({ error: "You are not a participant of this conversation" });
      }

      if (Number(conv.type) === 2 && Number(conv.is_read_only) === 1) {
        const role = Number(membership?.role || 0);
        const isAdmin = role === 1 || role === 2;
        if (!isAdmin) {
          return ack?.({ error: "Only admins can send messages in this group" });
        }
      }

      const safeContent = sanitizeRichText(content || "");
      const plainContent = toPlainText(safeContent);
      if (Number(kind) === MESSAGE_KIND.TEXT && !plainContent) {
        return ack?.({ error: "Message content is required" });
      }

      if (Number(kind) === MESSAGE_KIND.FILE) {
        const fileCheck = validateChatAttachmentPayload({
          file_reference_id,
          file_name,
          file_size_bytes,
        });
        if (!fileCheck.ok) {
          return ack?.({ error: fileCheck.error });
        }
      }

      // Rate limit: 60 msg/min per user
      const allowed = await checkRateLimit(`ratelimit:${userId}:msg`, 60, 60);
      if (!allowed) {
        return ack?.({ error: "Rate limit exceeded" });
      }

      // Idempotency check
      if (client_message_id) {
        const existing = await getIdempotencyKey(client_message_id);
        if (existing) {
          const msg = await Message.findByPk(existing, { raw: true });
          return ack?.({ success: true, message: msg });
        }
      }

      // Thread reply check
      if (parent_message_id) {
        const parent = await Message.findOne({
          where: { id: parent_message_id, conversation_id, org_id: orgId },
          attributes: ["id", "thread_reply_count"],
          raw: true,
        });
        if (!parent) return ack?.({ error: "Parent message not found" });
        if (parent.thread_reply_count >= 100) return ack?.({ error: "Thread reply limit reached (100)" });
      }

      // Insert message — the ONLY sync DB write
      const message = await Message.create({
        conversation_id,
        org_id: orgId,
        sender_id: userId,
        parent_message_id: parent_message_id || null,
        kind,
        content: safeContent || null,
        file_reference_id: file_reference_id || null,
        file_name: file_name || null,
        file_type: file_type ? String(file_type).slice(0, 255) : null,
        file_size_bytes: file_size_bytes || null,
        reply_to_message_id: reply_to_message_id || null,
        forwarded_from_id: forwarded_from_id || null,
        client_message_id: client_message_id || null,
      });

      // Set idempotency key
      if (client_message_id) {
        await setIdempotencyKey(client_message_id, message.id);
      }

      const msgData = message.toJSON();

      // Emit to sender (delivered ACK)
      ack?.({ success: true, message: msgData });

      // Emit to conversation room
      io.to(`conv:${conversation_id}`).emit("message:new", msgData);

      // Restore hidden conversations immediately (do not depend on async fanout worker).
      // This ensures the DM reappears in the sidebar without refresh.
      setImmediate(async () => {
        try {
          // Find recipients who have this conversation hidden.
          const hiddenRows = await ConversationParticipant.findAll({
            where: {
              conversation_id,
              org_id: orgId,
              is_active: 1,
              user_id: { [Op.ne]: userId },
              hidden_last_message_id: { [Op.not]: null, [Op.lt]: message.id },
            },
            attributes: ["user_id", "role", "is_favorite", "is_muted"],
            raw: true,
          });

          if (!hiddenRows || hiddenRows.length === 0) return;

          const hiddenUserIds = hiddenRows.map((r) => r.user_id);
          await ConversationParticipant.update(
            // IMPORTANT: Do NOT reset hidden_last_message_id.
            // It is the permanent per-user history cutoff (messages <= this remain hidden forever).
            // We only clear hidden_at so the conversation becomes visible again.
            { hidden_at: null },
            { where: { conversation_id, org_id: orgId, user_id: hiddenUserIds } }
          );

          const convRow = await Conversation.findOne({
            where: { id: conversation_id, org_id: orgId, is_deleted: 0 },
            attributes: [
              "id",
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
          if (!convRow) return;

          // For correctness, emit a hydrated payload (DM title/avatar from other user)
          // similar to the fanout job’s restore payload.
          const participantIdsForMembers = await getConversationParticipantIds(conversation_id, orgId);
          const lastSender = convRow.last_message_sender_id
            ? await getHydratedUser(convRow.last_message_sender_id, orgId).catch(() => null)
            : null;

          for (const row of hiddenRows) {
            const uid = row.user_id;
            let title = convRow.title;
            let avatarUrl = convRow.avatar_url;
            let otherUserId = null;
            let otherUser = null;

            if (Number(convRow.type) === 1) {
              otherUserId = participantIdsForMembers.find((id) => String(id) !== String(uid)) || null;
              if (otherUserId) {
                otherUser = await getHydratedUser(otherUserId, orgId);
                title = otherUser?.name || otherUser?.full_name || otherUser?.first_name || `User ${otherUserId}`;
                avatarUrl = otherUser?.avatar_url || null;
              } else {
                title = "Chat";
                avatarUrl = null;
              }
            }

            const payload = {
              id: convRow.id,
              type: convRow.type,
              title,
              avatar_url: avatarUrl,
              group_type: convRow.group_type,
              is_read_only: convRow.is_read_only,
              allow_read_receipts: convRow.allow_read_receipts,
              last_message_id: convRow.last_message_id,
              last_message_at: convRow.last_message_at ? new Date(convRow.last_message_at).toISOString() : null,
              last_message_preview: convRow.last_message_preview,
              last_message_sender_id: convRow.last_message_sender_id,
              created_by: convRow.created_by,
              created_at: convRow.created_at ? new Date(convRow.created_at).toISOString() : null,
              role: row.role,
              is_favorite: row.is_favorite,
              is_muted: row.is_muted,
              last_read_message_id: null,
              unread_count: null,
              last_message_sender: lastSender || null,
              other_user_id: otherUserId,
              other_user: otherUser || null,
              participant_count: participantIdsForMembers.length,
              members: participantIdsForMembers,
            };

            await emitConversationCreatedToUser(io, uid, payload);
          }
        } catch (err) {
          console.error("[messageHandler] immediate restore failed:", err.message);
        }
      });

      // Collect online recipients from room and mark them as delivered immediately
      const deliveredTo = await collectDeliveredRecipients(io, conversation_id, userId);
      const participantIds = await getConversationParticipantIds(conversation_id, orgId);
      const recipientCount = Math.max(0, participantIds.length - 1);

      if (deliveredTo.length > 0) {
        await Promise.all(
          deliveredTo.map((delivery) =>
            addMessageDelivery(message.id, delivery, conversation_id, orgId)
          )
        );
        await sendDeliveredEvent(io, conversation_id, message.id, recipientCount);
      }

      // Enqueue async fan-out (unread, notifications, conversation update, search)
      const fanoutPayload = {
        message_id: message.id,
        conversation_id,
        org_id: orgId,
        sender_id: userId,
        content: plainContent || null,
        file_name: file_name || null,
        kind,
        parent_message_id: parent_message_id || null,
        mentions: mentions || [],
      };

      const queuedJob = await addMessageFanoutJob(fanoutPayload);
      if (!queuedJob) {
        await processMessageFanout({ data: fanoutPayload });
      }
    } catch (error) {
      console.error("message:send error:", error.message);
      ack?.({ error: "Failed to send message" });
    }
  });

  // --- Message delivered acknowledgement from recipient client ---
  socket.on("message:delivered", async (data, ack) => {
    try {
      const { conversation_id, message_id } = data;
      if (!conversation_id || !message_id) {
        return ack?.({ error: "conversation_id and message_id required" });
      }

      const participantIds = await getConversationParticipantIds(conversation_id, orgId);
      if (!participantIds.map(String).includes(String(userId))) {
        return ack?.({ error: "User not part of conversation" });
      }

      const delivery = {
        user_id: userId,
        delivered_at: new Date().toISOString(),
      };
      await addMessageDelivery(message_id, delivery, conversation_id, orgId);

      const recipientCount = Math.max(0, participantIds.length - 1);
      await sendDeliveredEvent(io, conversation_id, message_id, recipientCount);

      ack?.({ success: true });
    } catch (error) {
      console.error("message:delivered error:", error.message);
      ack?.({ error: "Failed to acknowledge delivery" });
    }
  });

  // --- Edit message ---
  socket.on("message:edit", async (data, ack) => {
    try {
      const { message_id, content } = data;
      if (!message_id || content === undefined || content === null) {
        return ack?.({ error: "message_id and content required" });
      }

      const safeContent = sanitizeRichText(content || "");
      const plainContent = toPlainText(safeContent);
      if (!plainContent) {
        return ack?.({ error: "Message content is required" });
      }

      const message = await Message.findOne({
        where: { id: message_id, sender_id: userId, org_id: orgId, is_deleted: 0 },
      });
      if (!message) return ack?.({ error: "Message not found or not yours" });

      // Save edit history
      await MessageEdit.create({
        message_id,
        org_id: orgId,
        previous_content: message.content,
        edited_by: userId,
        edited_at: new Date(),
      });

      // Update message
      await message.update({ content: safeContent, is_edited: 1 });

      const updatedMsg = message.toJSON();
      ack?.({ success: true, message: updatedMsg });

      io.to(`conv:${message.conversation_id}`).emit("message:updated", updatedMsg);
    } catch (error) {
      console.error("message:edit error:", error.message);
      ack?.({ error: "Failed to edit message" });
    }
  });

  // --- Delete message ---
  socket.on("message:delete", async (data, ack) => {
    try {
      const { message_id, delete_type } = data;
      if (!message_id || !delete_type) return ack?.({ error: "message_id and delete_type required" });

      if (delete_type === "for_me") {
        await MessageDeletion.findOrCreate({
          where: { message_id, user_id: userId },
          defaults: { message_id, user_id: userId, org_id: orgId, deleted_at: new Date() },
        });
        ack?.({ success: true });
        socket.emit("message:deleted", { message_id, delete_type: "for_me" });
      } else if (delete_type === "for_all") {
        const message = await Message.findOne({
          where: { id: message_id, sender_id: userId, org_id: orgId, is_deleted: 0 },
        });
        if (!message) return ack?.({ error: "Message not found or not yours" });

        await message.update({ is_deleted: 1, content: null });
        ack?.({ success: true });

        io.to(`conv:${message.conversation_id}`).emit("message:deleted", {
          message_id,
          conversation_id: message.conversation_id,
          delete_type: "for_all",
        });
      } else {
        ack?.({ error: "Invalid delete_type" });
      }
    } catch (error) {
      console.error("message:delete error:", error.message);
      ack?.({ error: "Failed to delete message" });
    }
  });

  // --- React to message ---
  socket.on("message:react", async (data, ack) => {
    try {
      const { message_id, emoji } = data;
      if (!message_id || !emoji) return ack?.({ error: "message_id and emoji required" });

      const message = await Message.findOne({
        where: { id: message_id, org_id: orgId, is_deleted: 0 },
        attributes: ["id", "conversation_id"],
        raw: true,
      });
      if (!message) return ack?.({ error: "Message not found" });

      // Toggle reaction
      const existing = await MessageReaction.findOne({
        where: { message_id, user_id: userId, emoji },
      });

      if (existing) {
        await existing.destroy();
      } else {
        await MessageReaction.create({
          message_id,
          user_id: userId,
          org_id: orgId,
          emoji,
        });
      }

      // Fetch updated reactions for this message
      const reactions = await MessageReaction.findAll({
        where: { message_id },
        attributes: ["emoji", "user_id"],
        raw: true,
      });

      // Group by emoji
      const grouped = {};
      reactions.forEach((r) => {
        if (!grouped[r.emoji]) grouped[r.emoji] = [];
        grouped[r.emoji].push(r.user_id);
      });
      const reactionList = Object.entries(grouped).map(([emoji, by]) => ({ emoji, by }));

      ack?.({ success: true });
      io.to(`conv:${message.conversation_id}`).emit("message:reaction", {
        message_id,
        conversation_id: message.conversation_id,
        reactions: reactionList,
      });
    } catch (error) {
      console.error("message:react error:", error.message);
      ack?.({ error: "Failed to react" });
    }
  });
}

module.exports = { setupMessageHandler, sendDeliveredEvent };
