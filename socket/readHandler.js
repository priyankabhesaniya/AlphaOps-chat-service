const { ConversationParticipant, Conversation, Message } = require("../models");
const { resetUnread } = require("../redis/unreadService");
const { Op } = require("sequelize");

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
        const messageForReceipt = isValidMessageId
          ? await Message.findByPk(messageIdInt, { attributes: ["client_message_id", "sender_id"], raw: true })
          : null;

        // Compute all_read: count participants (excluding current user who just read)
        // whose last_read_message_id >= messageIdInt (they've read at least up to this message)
        let allRead = false;
        if (isValidMessageId && messageForReceipt) {
          // Total active recipients (everyone except the original message sender)
          const totalRecipients = await ConversationParticipant.count({
            where: {
              conversation_id,
              org_id: orgId,
              is_active: 1,
              user_id: { [Op.ne]: messageForReceipt.sender_id },
            },
          });

          // How many of those have read up to this message (including the current user who just read)
          const readCount = await ConversationParticipant.count({
            where: {
              conversation_id,
              org_id: orgId,
              is_active: 1,
              user_id: { [Op.ne]: messageForReceipt.sender_id },
              last_read_message_id: { [Op.gte]: messageIdInt },
            },
          });

          allRead = totalRecipients > 0 && readCount >= totalRecipients;
        }

        socket.to(`conv:${conversation_id}`).emit("message:read_receipt", {
          conversation_id,
          user_id: userId,
          message_id,
          client_message_id: messageForReceipt?.client_message_id || null,
          read_at: new Date().toISOString(),
          all_read: allRead,
        });
      }
    } catch (error) {
      console.error("message:read error:", error.message);
      ack?.({ error: "Failed to mark as read" });
    }
  });
}

module.exports = setupReadHandler;
