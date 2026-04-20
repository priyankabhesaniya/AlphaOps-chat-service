const {
  Message,
  MessageDeletion,
  MessageReaction,
  MessageEdit,
  StarredMessage,
  ConversationParticipant,
} = require("../models");
const { sendResponse } = require("../utils/responseUtils");
const { getCachedUsers } = require("../redis/cacheService");
const { Op } = require("sequelize");

// GET /conversations/:id/messages — cursor-based pagination
const getMessages = async (req, res) => {
  try {
    const { userId, org_id } = req.user;
    const { id: conversationId } = req.params;
    const { cursor, limit = 50 } = req.query;
    const queryLimit = Math.min(parseInt(limit), 100);

    // Fetch extra rows to account for "deleted for me"
    const fetchLimit = queryLimit + 5;

    const where = {
      conversation_id: conversationId,
      org_id,
    };

    if (cursor) {
      where.id = { [Op.lt]: parseInt(cursor) };
    }

    const messages = await Message.findAll({
      where,
      order: [["id", "DESC"]],
      limit: fetchLimit,
      raw: true,
    });

    if (messages.length === 0) {
      return sendResponse(res, 200, true, "Messages", {
        messages: [],
        next_cursor: null,
        has_more: false,
      });
    }

    // Batch-check "deleted for me"
    const messageIds = messages.map((m) => m.id);
    const deletedForMe = await MessageDeletion.findAll({
      where: { user_id: userId, message_id: { [Op.in]: messageIds } },
      attributes: ["message_id"],
      raw: true,
    });
    const deletedSet = new Set(deletedForMe.map((d) => d.message_id));

    // Filter and trim
    let filtered = messages.filter((m) => !deletedSet.has(m.id));
    const hasMore = filtered.length > queryLimit;
    filtered = filtered.slice(0, queryLimit);
    const nextCursor = filtered.length > 0 ? filtered[filtered.length - 1].id : null;

    // Batch-load sender info
    const senderIds = [...new Set(filtered.map((m) => m.sender_id))];
    const userMap = await getCachedUsers(senderIds);

    // Batch-load reactions
    const filteredIds = filtered.map((m) => m.id);
    const reactions = await MessageReaction.findAll({
      where: { message_id: { [Op.in]: filteredIds } },
      raw: true,
    });

    // Group reactions by message_id
    const reactionMap = {};
    for (const r of reactions) {
      if (!reactionMap[r.message_id]) reactionMap[r.message_id] = [];
      reactionMap[r.message_id].push(r);
    }

    // Batch-load reply-to messages
    const replyToIds = [...new Set(filtered.map((m) => m.reply_to_message_id).filter(Boolean))];
    let replyToMap = {};
    if (replyToIds.length > 0) {
      const replyMsgs = await Message.findAll({
        where: { id: { [Op.in]: replyToIds } },
        attributes: ["id", "sender_id", "content", "kind"],
        raw: true,
      });
      for (const rm of replyMsgs) {
        replyToMap[rm.id] = rm;
      }
    }

    // Assemble result
    const result = filtered.map((m) => ({
      ...m,
      sender: userMap[m.sender_id] || null,
      reactions: reactionMap[m.id] || [],
      reply_to_message: m.reply_to_message_id ? (replyToMap[m.reply_to_message_id] || null) : null,
      // Mask deleted messages
      content: m.is_deleted ? null : m.content,
    }));

    sendResponse(res, 200, true, "Messages", {
      messages: result,
      next_cursor: hasMore ? nextCursor : null,
      has_more: hasMore,
    });
  } catch (error) {
    console.error("getMessages error:", error.message);
    sendResponse(res, 500, false, "Failed to fetch messages");
  }
};

// GET /conversations/:id/messages/:msgId/thread — thread replies
const getThread = async (req, res) => {
  try {
    const { org_id } = req.user;
    const { id: conversationId, msgId } = req.params;

    const replies = await Message.findAll({
      where: {
        conversation_id: conversationId,
        org_id,
        parent_message_id: msgId,
      },
      order: [["id", "ASC"]],
      limit: 100,
      raw: true,
    });

    // Parent message
    const parent = await Message.findOne({
      where: { id: msgId, conversation_id: conversationId, org_id },
      raw: true,
    });

    // Batch user lookup
    const allSenderIds = [...new Set([parent?.sender_id, ...replies.map((r) => r.sender_id)].filter(Boolean))];
    const userMap = await getCachedUsers(allSenderIds);

    // Batch reactions
    const allIds = [parent?.id, ...replies.map((r) => r.id)].filter(Boolean);
    const reactions = await MessageReaction.findAll({
      where: { message_id: { [Op.in]: allIds } },
      raw: true,
    });
    const reactionMap = {};
    for (const r of reactions) {
      if (!reactionMap[r.message_id]) reactionMap[r.message_id] = [];
      reactionMap[r.message_id].push(r);
    }

    const formatMsg = (m) => ({
      ...m,
      sender: userMap[m.sender_id] || null,
      reactions: reactionMap[m.id] || [],
      content: m.is_deleted ? null : m.content,
    });

    sendResponse(res, 200, true, "Thread", {
      parent: parent ? formatMsg(parent) : null,
      replies: replies.map(formatMsg),
    });
  } catch (error) {
    console.error("getThread error:", error.message);
    sendResponse(res, 500, false, "Failed to fetch thread");
  }
};

// GET /conversations/:id/messages/:msgId/info — who read + reactions + edit history
const getMessageInfo = async (req, res) => {
  try {
    const { org_id } = req.user;
    const { id: conversationId, msgId } = req.params;

    // Who read (watermark-based)
    const readBy = await ConversationParticipant.findAll({
      where: {
        conversation_id: conversationId,
        is_active: 1,
        last_read_message_id: { [Op.gte]: msgId },
      },
      attributes: ["user_id", "last_read_at"],
      raw: true,
    });

    const userIds = readBy.map((r) => r.user_id);
    const userMap = await getCachedUsers(userIds);

    const readReceipts = readBy.map((r) => ({
      user_id: r.user_id,
      user: userMap[r.user_id] || null,
      read_at: r.last_read_at,
    }));

    // Reactions
    const reactions = await MessageReaction.findAll({
      where: { message_id: msgId },
      raw: true,
    });

    // Group by emoji
    const groupedReactions = {};
    for (const r of reactions) {
      if (!groupedReactions[r.emoji]) groupedReactions[r.emoji] = [];
      groupedReactions[r.emoji].push(r.user_id);
    }

    // Edit history
    const edits = await MessageEdit.findAll({
      where: { message_id: msgId },
      order: [["edited_at", "DESC"]],
      raw: true,
    });

    sendResponse(res, 200, true, "Message info", {
      read_by: readReceipts,
      reactions: groupedReactions,
      edit_history: edits,
    });
  } catch (error) {
    console.error("getMessageInfo error:", error.message);
    sendResponse(res, 500, false, "Failed to fetch message info");
  }
};

// GET /conversations/:id/pinned — pinned messages
const getPinnedMessages = async (req, res) => {
  try {
    const { org_id } = req.user;
    const { id: conversationId } = req.params;

    const pinned = await Message.findAll({
      where: { conversation_id: conversationId, org_id, is_pinned: 1, is_deleted: 0 },
      order: [["id", "DESC"]],
      raw: true,
    });

    const senderIds = [...new Set(pinned.map((m) => m.sender_id))];
    const userMap = await getCachedUsers(senderIds);

    const result = pinned.map((m) => ({
      ...m,
      sender: userMap[m.sender_id] || null,
    }));

    sendResponse(res, 200, true, "Pinned messages", { messages: result });
  } catch (error) {
    console.error("getPinnedMessages error:", error.message);
    sendResponse(res, 500, false, "Failed to fetch pinned messages");
  }
};

// PUT /messages/:id/pin — toggle pin
const togglePin = async (req, res) => {
  try {
    const { org_id } = req.user;
    const { id: messageId } = req.params;

    const message = await Message.findOne({
      where: { id: messageId, org_id, is_deleted: 0 },
    });
    if (!message) {
      return sendResponse(res, 404, false, "Message not found");
    }

    await message.update({ is_pinned: message.is_pinned ? 0 : 1 });
    sendResponse(res, 200, true, "Pin toggled", { is_pinned: message.is_pinned });
  } catch (error) {
    console.error("togglePin error:", error.message);
    sendResponse(res, 500, false, "Failed to toggle pin");
  }
};

// GET /conversations/:id/files — file messages
const getFiles = async (req, res) => {
  try {
    const { org_id } = req.user;
    const { id: conversationId } = req.params;
    const { cursor, limit = 30 } = req.query;
    const queryLimit = Math.min(parseInt(limit), 100);

    const where = {
      conversation_id: conversationId,
      org_id,
      kind: 2, // file
      is_deleted: 0,
    };
    if (cursor) where.id = { [Op.lt]: parseInt(cursor) };

    const files = await Message.findAll({
      where,
      order: [["id", "DESC"]],
      limit: queryLimit + 1,
      raw: true,
    });

    const hasMore = files.length > queryLimit;
    const result = files.slice(0, queryLimit);
    const nextCursor = result.length > 0 ? result[result.length - 1].id : null;

    const senderIds = [...new Set(result.map((m) => m.sender_id))];
    const userMap = await getCachedUsers(senderIds);

    sendResponse(res, 200, true, "Files", {
      files: result.map((m) => ({ ...m, sender: userMap[m.sender_id] || null })),
      next_cursor: hasMore ? nextCursor : null,
      has_more: hasMore,
    });
  } catch (error) {
    console.error("getFiles error:", error.message);
    sendResponse(res, 500, false, "Failed to fetch files");
  }
};

// GET /conversations/:id/starred — starred messages by current user
const getStarredMessages = async (req, res) => {
  try {
    const { userId, org_id } = req.user;
    const { id: conversationId } = req.params;
    const { cursor, limit = 30 } = req.query;
    const queryLimit = Math.min(parseInt(limit), 100);

    const where = {
      user_id: userId,
      conversation_id: conversationId,
      org_id,
    };
    if (cursor) where.id = { [Op.lt]: parseInt(cursor) };

    const stars = await StarredMessage.findAll({
      where,
      order: [["created_at", "DESC"]],
      limit: queryLimit + 1,
      raw: true,
    });

    const hasMore = stars.length > queryLimit;
    const result = stars.slice(0, queryLimit);
    const messageIds = result.map((s) => s.message_id);

    // Fetch actual messages
    const messages = await Message.findAll({
      where: { id: { [Op.in]: messageIds }, is_deleted: 0 },
      raw: true,
    });
    const msgMap = {};
    for (const m of messages) msgMap[m.id] = m;

    const senderIds = [...new Set(messages.map((m) => m.sender_id))];
    const userMap = await getCachedUsers(senderIds);

    const starredWithMessages = result
      .map((s) => {
        const msg = msgMap[s.message_id];
        if (!msg) return null;
        return {
          starred_at: s.created_at,
          message: { ...msg, sender: userMap[msg.sender_id] || null },
        };
      })
      .filter(Boolean);

    sendResponse(res, 200, true, "Starred messages", {
      starred: starredWithMessages,
      next_cursor: hasMore ? result[result.length - 1].id : null,
      has_more: hasMore,
    });
  } catch (error) {
    console.error("getStarredMessages error:", error.message);
    sendResponse(res, 500, false, "Failed to fetch starred messages");
  }
};

// PUT /messages/:id/star — toggle star
const toggleStar = async (req, res) => {
  try {
    const { userId, org_id } = req.user;
    const { id: messageId } = req.params;

    const message = await Message.findOne({
      where: { id: messageId, org_id, is_deleted: 0 },
      attributes: ["id", "conversation_id"],
      raw: true,
    });
    if (!message) {
      return sendResponse(res, 404, false, "Message not found");
    }

    const existing = await StarredMessage.findOne({
      where: { message_id: messageId, user_id: userId },
    });

    if (existing) {
      await existing.destroy();
      sendResponse(res, 200, true, "Star removed", { is_starred: false });
    } else {
      await StarredMessage.create({
        message_id: messageId,
        user_id: userId,
        conversation_id: message.conversation_id,
        org_id,
      });
      sendResponse(res, 200, true, "Star added", { is_starred: true });
    }
  } catch (error) {
    console.error("toggleStar error:", error.message);
    sendResponse(res, 500, false, "Failed to toggle star");
  }
};

module.exports = {
  getMessages,
  getThread,
  getMessageInfo,
  getPinnedMessages,
  togglePin,
  getFiles,
  getStarredMessages,
  toggleStar,
};
