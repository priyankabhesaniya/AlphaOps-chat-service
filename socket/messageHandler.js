const { Message, ConversationParticipant, MessageReaction, MessageEdit, MessageDeletion } = require("../models");
const { getIdempotencyKey, setIdempotencyKey, getParticipantIds, checkRateLimit } = require("../redis/cacheService");
const { addMessageFanoutJob } = require("../jobs/queue");

const MESSAGE_KIND = { TEXT: 1, FILE: 2, SYSTEM: 3 };

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
        mentions,
        client_message_id,
      } = data;

      if (!conversation_id) {
        return ack?.({ error: "conversation_id is required" });
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
        content: content || null,
        file_reference_id: file_reference_id || null,
        file_name: file_name || null,
        file_type: file_type || null,
        file_size_bytes: file_size_bytes || null,
        reply_to_message_id: reply_to_message_id || null,
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

      // Enqueue async fan-out (unread, notifications, conversation update, search)
      await addMessageFanoutJob({
        message_id: message.id,
        conversation_id,
        org_id: orgId,
        sender_id: userId,
        content: content || null,
        kind,
        parent_message_id: parent_message_id || null,
        mentions: mentions || [],
      });
    } catch (error) {
      console.error("message:send error:", error.message);
      ack?.({ error: "Failed to send message" });
    }
  });

  // --- Edit message ---
  socket.on("message:edit", async (data, ack) => {
    try {
      const { message_id, content } = data;
      if (!message_id || !content) return ack?.({ error: "message_id and content required" });

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
      await message.update({ content, is_edited: 1 });

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
        // Only sender sees this change via socket
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
        reactions: reactionList,
      });
    } catch (error) {
      console.error("message:react error:", error.message);
      ack?.({ error: "Failed to react" });
    }
  });
}

module.exports = setupMessageHandler;
