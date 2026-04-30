const { Op } = require("sequelize");
const { MessageMention, Message, Conversation } = require("../models");
const { getCachedUsers } = require("../redis/cacheService");
const { sendResponse } = require("../utils/responseUtils");

// GET /mentions?page=1&limit=20
// Returns group messages where the current user was @mentioned (type=1) or @all (type=2)
const getMentions = async (req, res) => {
  try {
    const { userId, org_id } = req.user;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, parseInt(req.query.limit, 10) || 20);
    const offset = (page - 1) * limit;

    const mentions = await MessageMention.findAndCountAll({
      where: {
        org_id,
        [Op.or]: [
          { mentioned_user_id: userId },
          { mention_type: 2 }, // @all
        ],
      },
      include: [
        {
          model: Message,
          as: "message",
          where: { is_deleted: 0, kind: 1 },
          required: true,
          include: [
            {
              model: Conversation,
              as: "conversation",
              where: { type: 2, is_deleted: 0 }, // group conversations only
              required: true,
              attributes: ["id", "title", "avatar_url"],
            },
          ],
          attributes: ["id", "content", "sender_id", "created_at"],
        },
      ],
      order: [["created_at", "DESC"]],
      limit,
      offset,
    });

    // Collect all unique sender IDs
    const senderIds = [...new Set(mentions.rows.map((m) => m.message?.sender_id).filter(Boolean))];
    const senderMap = senderIds.length ? await getCachedUsers(senderIds) : {};

    const rows = mentions.rows.map((m) => {
      const msg = m.message;
      const conv = msg?.conversation;
      const sender = senderMap[msg?.sender_id] || null;
      return {
        mention_id: m.id,
        message_id: msg?.id,
        content: msg?.content || "",
        created_at: m.created_at,
        conversation_id: conv?.id,
        conversation_title: conv?.title || "Group",
        conversation_avatar: conv?.avatar_url || null,
        sender: sender
          ? {
              id: msg.sender_id,
              name: sender.name || sender.full_name || sender.first_name || `User ${msg.sender_id}`,
              avatar_url: sender.avatar_url || null,
            }
          : { id: msg?.sender_id, name: `User ${msg?.sender_id}`, avatar_url: null },
        mention_type: m.mention_type,
      };
    });

    sendResponse(res, 200, true, "Mentions fetched", {
      rows,
      total: mentions.count,
      page,
      limit,
      has_more: offset + rows.length < mentions.count,
    });
  } catch (error) {
    console.error("getMentions error:", error.message);
    sendResponse(res, 500, false, "Failed to fetch mentions");
  }
};

module.exports = { getMentions };
