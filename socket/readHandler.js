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

      // Reset unread in Redis (instant)
      await resetUnread(userId, conversation_id);

      // Update DB watermark
      await ConversationParticipant.update(
        {
          last_read_message_id: message_id,
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
