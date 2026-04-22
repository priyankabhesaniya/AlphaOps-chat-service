const { ConversationParticipant, Conversation } = require("../models");
const { resetUnread } = require("../redis/unreadService");

function setupReadHandler(io, socket) {
  const { userId, orgId } = socket;

  // Mark conversation as read up to a specific message
  socket.on("message:read", async (data, ack) => {
    try {
      const { conversation_id, message_id } = data;
      if (!conversation_id || !message_id) {
        return ack?.({ error: "conversation_id and message_id required" });
      }

      // Guard: message_id must be a valid integer (not a client temp UUID)
      const messageIdInt = parseInt(message_id, 10);
      const isValidMessageId = !isNaN(messageIdInt) && messageIdInt > 0 && String(messageIdInt) === String(message_id).trim();

      // Reset unread in Redis (instant) — always safe
      await resetUnread(userId, conversation_id);

      // Only update DB watermark when we have a real server-assigned integer ID
      if (isValidMessageId) {
        await ConversationParticipant.update(
          {
            last_read_message_id: messageIdInt,
            last_read_at: new Date(),
            unread_count: 0,
          },
          {
            where: {
              conversation_id,
              user_id: userId,
              org_id: orgId,
              is_active: 1,
            },
          }
        );
      } else {
        // Temp ID — still clear unread_count column but skip the invalid message ID
        await ConversationParticipant.update(
          { last_read_at: new Date(), unread_count: 0 },
          { where: { conversation_id, user_id: userId, org_id: orgId, is_active: 1 } }
        );
      }

      ack?.({ success: true });

      // Broadcast read receipt if conversation allows it
      const conv = await Conversation.findOne({
        where: { id: conversation_id, org_id: orgId },
        attributes: ["allow_read_receipts"],
        raw: true,
      });

      if (conv && conv.allow_read_receipts) {
        socket.to(`conv:${conversation_id}`).emit("message:read_receipt", {
          conversation_id,
          user_id: userId,
          message_id,
          read_at: new Date().toISOString(),
        });
      }
    } catch (error) {
      console.error("message:read error:", error.message);
      ack?.({ error: "Failed to mark as read" });
    }
  });
}

module.exports = setupReadHandler;
