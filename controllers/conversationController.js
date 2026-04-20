const {
  Conversation,
  ConversationParticipant,
  ConversationActivityLog,
  Message,
} = require("../models");
const { sendResponse } = require("../utils/responseUtils");
const { invalidateParticipants, setParticipantIds, getCachedUsers } = require("../redis/cacheService");
const { getAllUnreads, removeConversationUnread } = require("../redis/unreadService");
const { Op } = require("sequelize");
const { sequelizeWrite } = require("../config/database");

// GET /conversations — list user's conversations
const getConversations = async (req, res) => {
  try {
    const { userId, org_id } = req.user;
    const { page = 1, limit = 50 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const participants = await ConversationParticipant.findAll({
      where: { user_id: userId, org_id, is_active: 1 },
      include: [
        {
          model: Conversation,
          as: "conversation",
          where: { is_deleted: 0 },
          attributes: [
            "id", "type", "title", "avatar_url", "is_public",
            "allow_read_receipts",
            "last_message_id", "last_message_at",
            "last_message_preview", "last_message_sender_id",
            "created_by", "created_at",
          ],
        },
      ],
      attributes: ["conversation_id", "role", "is_favorite", "is_muted", "last_read_message_id"],
      order: [
        ["is_favorite", "DESC"],
        [sequelizeWrite.literal("CASE WHEN `conversation`.`last_message_at` IS NULL THEN 1 ELSE 0 END"), "ASC"],
        [{ model: Conversation, as: "conversation" }, "last_message_at", "DESC"],
      ],
      limit: parseInt(limit),
      offset,
    });

    // Fetch unread counts from Redis/fallback
    const unreads = await getAllUnreads(userId);

    // Get conversation IDs for participant counts + DM other-user resolution
    const convIds = participants.map((p) => p.conversation_id);

    // Batch-fetch participant counts
    const countRows = await ConversationParticipant.findAll({
      where: { conversation_id: { [Op.in]: convIds }, is_active: 1 },
      attributes: [
        "conversation_id",
        [sequelizeWrite.fn("COUNT", sequelizeWrite.col("id")), "count"],
      ],
      group: ["conversation_id"],
      raw: true,
    });
    const countMap = {};
    for (const r of countRows) countMap[r.conversation_id] = parseInt(r.count);

    // For DMs, find the other user in each DM conversation
    const dmConvIds = participants
      .filter((p) => p.conversation?.type === 1)
      .map((p) => p.conversation_id);

    let dmOtherUserMap = {};
    if (dmConvIds.length > 0) {
      const dmOthers = await ConversationParticipant.findAll({
        where: {
          conversation_id: { [Op.in]: dmConvIds },
          user_id: { [Op.ne]: userId },
          is_active: 1,
        },
        attributes: ["conversation_id", "user_id"],
        raw: true,
      });
      // Map conversationId → otherUserId
      for (const d of dmOthers) {
        dmOtherUserMap[d.conversation_id] = d.user_id;
      }
    }

    // Collect all user IDs we need: senders + DM other users
    const senderIds = participants
      .map((p) => p.conversation?.last_message_sender_id)
      .filter(Boolean);
    const dmOtherUserIds = Object.values(dmOtherUserMap);
    const allUserIds = [...new Set([...senderIds, ...dmOtherUserIds])];
    const userMap = await getCachedUsers(allUserIds);

    const conversations = participants.map((p) => {
      const conv = p.conversation.toJSON();
      const participantCount = countMap[conv.id] || 0;

      // For DMs, set title to other user's name
      let title = conv.title;
      if (conv.type === 1) {
        const otherUserId = dmOtherUserMap[conv.id];
        const otherUser = otherUserId ? userMap[otherUserId] : null;
        title = otherUser?.name || `User ${otherUserId || ""}`;
      }

      return {
        ...conv,
        title,
        role: p.role,
        is_favorite: p.is_favorite,
        is_muted: p.is_muted,
        last_read_message_id: p.last_read_message_id,
        unread_count: unreads[String(conv.id)] || 0,
        last_message_sender: userMap[conv.last_message_sender_id] || null,
        participant_count: participantCount,
      };
    });

    sendResponse(res, 200, true, "Conversations fetched", { conversations });
  } catch (error) {
    console.error("getConversations error:", error.message);
    sendResponse(res, 500, false, "Failed to fetch conversations");
  }
};

// POST /conversations — create DM or group
const createConversation = async (req, res) => {
  const t = await sequelizeWrite.transaction();
  try {
    const { userId, org_id } = req.user;
    const { type, title, description, participant_ids = [], avatar_url } = req.body;

    if (!type || ![1, 2].includes(type)) {
      return sendResponse(res, 400, false, "Invalid conversation type (1=dm, 2=group)");
    }

    // DM: ensure participant_ids has exactly 1 other user
    if (type === 1) {
      if (participant_ids.length !== 1) {
        return sendResponse(res, 400, false, "DM requires exactly one other participant");
      }

      const otherUserId = participant_ids[0];

      // Check for existing DM
      const existingDm = await sequelizeWrite.query(
        `SELECT cp1.conversation_id
         FROM conversation_participants cp1
         JOIN conversation_participants cp2 ON cp1.conversation_id = cp2.conversation_id
         JOIN conversations c ON c.id = cp1.conversation_id AND c.type = 1 AND c.is_deleted = 0
         WHERE cp1.user_id = :userA AND cp2.user_id = :userB
           AND cp1.org_id = :orgId AND cp1.is_active = 1 AND cp2.is_active = 1
         LIMIT 1`,
        {
          replacements: { userA: userId, userB: otherUserId, orgId: org_id },
          type: sequelizeWrite.QueryTypes.SELECT,
          transaction: t,
        }
      );

      if (existingDm.length > 0) {
        await t.commit();
        return sendResponse(res, 200, true, "Existing DM found", {
          conversation_id: existingDm[0].conversation_id,
          is_existing: true,
        });
      }
    }

    // Group: at least 1 other participant
    if (type === 2 && participant_ids.length < 1) {
      return sendResponse(res, 400, false, "Group requires at least one other participant");
    }

    // Create conversation
    const conversation = await Conversation.create(
      {
        org_id,
        type,
        title: type === 2 ? title : null,
        description: type === 2 ? description : null,
        avatar_url: type === 2 ? avatar_url : null,
        created_by: userId,
      },
      { transaction: t }
    );

    // Add creator as owner
    const allParticipantIds = [userId, ...participant_ids.filter((id) => id !== userId)];
    const participantRows = allParticipantIds.map((uid, idx) => ({
      conversation_id: conversation.id,
      user_id: uid,
      org_id,
      role: idx === 0 ? 1 : 3, // first = owner, rest = member
      joined_at: new Date(),
    }));

    await ConversationParticipant.bulkCreate(participantRows, { transaction: t });

    // System message for group creation
    if (type === 2) {
      await Message.create(
        {
          conversation_id: conversation.id,
          org_id,
          sender_id: userId,
          kind: 3,
          content: null,
          system_action: "created_group",
        },
        { transaction: t }
      );

      await ConversationActivityLog.create(
        {
          conversation_id: conversation.id,
          org_id,
          actor_id: userId,
          action: "created",
        },
        { transaction: t }
      );
    }

    await t.commit();

    // Cache participant IDs
    await setParticipantIds(conversation.id, allParticipantIds);

    sendResponse(res, 201, true, "Conversation created", {
      conversation_id: conversation.id,
      type,
    });
  } catch (error) {
    await t.rollback();
    console.error("createConversation error:", error.message);
    sendResponse(res, 500, false, "Failed to create conversation");
  }
};

// GET /conversations/:id — conversation details + participants
const getConversationById = async (req, res) => {
  try {
    const { org_id } = req.user;
    const { id } = req.params;

    const conversation = await Conversation.findOne({
      where: { id, org_id, is_deleted: 0 },
      include: [
        {
          model: ConversationParticipant,
          as: "participants",
          where: { is_active: 1 },
          attributes: ["user_id", "role", "joined_at"],
        },
      ],
    });

    if (!conversation) {
      return sendResponse(res, 404, false, "Conversation not found");
    }

    // Batch user lookup for participants
    const userIds = conversation.participants.map((p) => p.user_id);
    const userMap = await getCachedUsers(userIds);

    const result = conversation.toJSON();
    result.participants = result.participants.map((p) => ({
      ...p,
      user: userMap[p.user_id] || null,
    }));

    sendResponse(res, 200, true, "Conversation details", { conversation: result });
  } catch (error) {
    console.error("getConversationById error:", error.message);
    sendResponse(res, 500, false, "Failed to fetch conversation");
  }
};

// PUT /conversations/:id — update group info
const updateConversation = async (req, res) => {
  try {
    const { org_id, userId } = req.user;
    const { id } = req.params;
    const { title, description, avatar_url, is_public, allow_read_receipts } = req.body;

    const conversation = await Conversation.findOne({
      where: { id, org_id, type: 2, is_deleted: 0 },
    });
    if (!conversation) {
      return sendResponse(res, 404, false, "Group not found");
    }

    const updates = {};
    if (title !== undefined) updates.title = title;
    if (description !== undefined) updates.description = description;
    if (avatar_url !== undefined) updates.avatar_url = avatar_url;
    if (is_public !== undefined) updates.is_public = is_public ? 1 : 0;
    if (allow_read_receipts !== undefined) updates.allow_read_receipts = allow_read_receipts ? 1 : 0;

    await conversation.update(updates);

    // Log activity
    if (title !== undefined) {
      await ConversationActivityLog.create({
        conversation_id: id,
        org_id,
        actor_id: userId,
        action: "title_changed",
        metadata: { title },
      });
    }

    sendResponse(res, 200, true, "Conversation updated", { conversation: conversation.toJSON() });
  } catch (error) {
    console.error("updateConversation error:", error.message);
    sendResponse(res, 500, false, "Failed to update conversation");
  }
};

// DELETE /conversations/:id — leave conversation
const leaveConversation = async (req, res) => {
  try {
    const { userId, org_id } = req.user;
    const { id } = req.params;

    const participant = await ConversationParticipant.findOne({
      where: { conversation_id: id, user_id: userId, org_id, is_active: 1 },
    });
    if (!participant) {
      return sendResponse(res, 404, false, "Not a participant");
    }

    // Owner cannot leave without transferring ownership
    if (participant.role === 1) {
      const otherAdmins = await ConversationParticipant.count({
        where: { conversation_id: id, is_active: 1, user_id: { [Op.ne]: userId }, role: { [Op.in]: [1, 2] } },
      });
      if (otherAdmins === 0) {
        return sendResponse(res, 400, false, "Transfer ownership before leaving");
      }
    }

    await participant.update({ is_active: 0, left_at: new Date() });
    await invalidateParticipants(id);
    await removeConversationUnread(userId, id);

    // Log + system message
    await ConversationActivityLog.create({
      conversation_id: id, org_id, actor_id: userId, action: "left",
    });
    await Message.create({
      conversation_id: id, org_id, sender_id: userId,
      kind: 3, system_action: "member_left",
    });

    sendResponse(res, 200, true, "Left conversation");
  } catch (error) {
    console.error("leaveConversation error:", error.message);
    sendResponse(res, 500, false, "Failed to leave conversation");
  }
};

// POST /conversations/:id/members — add members
const addMembers = async (req, res) => {
  const t = await sequelizeWrite.transaction();
  try {
    const { userId, org_id } = req.user;
    const { id } = req.params;
    const { user_ids } = req.body;

    if (!user_ids || !Array.isArray(user_ids) || user_ids.length === 0) {
      return sendResponse(res, 400, false, "user_ids array required");
    }

    const conversation = await Conversation.findOne({
      where: { id, org_id, type: 2, is_deleted: 0 },
      transaction: t,
    });
    if (!conversation) {
      await t.rollback();
      return sendResponse(res, 404, false, "Group not found");
    }

    // Filter out already-active participants
    const existing = await ConversationParticipant.findAll({
      where: { conversation_id: id, user_id: user_ids, is_active: 1 },
      attributes: ["user_id"],
      raw: true,
      transaction: t,
    });
    const existingSet = new Set(existing.map((e) => e.user_id));
    const newUserIds = user_ids.filter((uid) => !existingSet.has(uid));

    if (newUserIds.length === 0) {
      await t.commit();
      return sendResponse(res, 200, true, "All users already in group");
    }

    // Re-activate or create participants
    for (const uid of newUserIds) {
      const [participant, created] = await ConversationParticipant.findOrCreate({
        where: { conversation_id: id, user_id: uid },
        defaults: { conversation_id: id, user_id: uid, org_id, role: 3, joined_at: new Date() },
        transaction: t,
      });
      if (!created && !participant.is_active) {
        await participant.update({ is_active: 1, left_at: null, role: 3, joined_at: new Date() }, { transaction: t });
      }
    }

    // System message + log for each member
    for (const uid of newUserIds) {
      await Message.create(
        { conversation_id: id, org_id, sender_id: userId, kind: 3, system_action: "member_added" },
        { transaction: t }
      );
      await ConversationActivityLog.create(
        { conversation_id: id, org_id, actor_id: userId, action: "member_added", target_user_id: uid },
        { transaction: t }
      );
    }

    await t.commit();
    await invalidateParticipants(id);

    sendResponse(res, 200, true, "Members added", { added: newUserIds });
  } catch (error) {
    await t.rollback();
    console.error("addMembers error:", error.message);
    sendResponse(res, 500, false, "Failed to add members");
  }
};

// DELETE /conversations/:id/members/:userId — remove member
const removeMember = async (req, res) => {
  try {
    const { userId: actorId, org_id } = req.user;
    const { id, userId: targetUserId } = req.params;

    const target = await ConversationParticipant.findOne({
      where: { conversation_id: id, user_id: targetUserId, org_id, is_active: 1 },
    });
    if (!target) {
      return sendResponse(res, 404, false, "User not in conversation");
    }

    // Cannot remove owner
    if (target.role === 1) {
      return sendResponse(res, 400, false, "Cannot remove conversation owner");
    }

    await target.update({ is_active: 0, left_at: new Date() });
    await invalidateParticipants(id);
    await removeConversationUnread(targetUserId, id);

    await ConversationActivityLog.create({
      conversation_id: id, org_id, actor_id: actorId, action: "member_removed", target_user_id: targetUserId,
    });
    await Message.create({
      conversation_id: id, org_id, sender_id: actorId, kind: 3, system_action: "member_removed",
    });

    sendResponse(res, 200, true, "Member removed");
  } catch (error) {
    console.error("removeMember error:", error.message);
    sendResponse(res, 500, false, "Failed to remove member");
  }
};

// PUT /conversations/:id/members/:userId/role — change role
const changeRole = async (req, res) => {
  try {
    const { org_id, userId: actorId } = req.user;
    const { id, userId: targetUserId } = req.params;
    const { role } = req.body;

    if (![1, 2, 3].includes(role)) {
      return sendResponse(res, 400, false, "Invalid role (1=owner, 2=admin, 3=member)");
    }

    const target = await ConversationParticipant.findOne({
      where: { conversation_id: id, user_id: targetUserId, org_id, is_active: 1 },
    });
    if (!target) {
      return sendResponse(res, 404, false, "User not in conversation");
    }

    // Only owner can transfer ownership
    if (role === 1) {
      const actor = await ConversationParticipant.findOne({
        where: { conversation_id: id, user_id: actorId, org_id, is_active: 1, role: 1 },
      });
      if (!actor) {
        return sendResponse(res, 403, false, "Only owner can transfer ownership");
      }
      // Demote current owner to admin
      await actor.update({ role: 2 });
    }

    await target.update({ role });

    await ConversationActivityLog.create({
      conversation_id: id, org_id, actor_id: actorId,
      action: "role_changed", target_user_id: targetUserId,
      metadata: { new_role: role },
    });

    sendResponse(res, 200, true, "Role updated");
  } catch (error) {
    console.error("changeRole error:", error.message);
    sendResponse(res, 500, false, "Failed to change role");
  }
};

// PUT /conversations/:id/favorite — toggle favorite
const toggleFavorite = async (req, res) => {
  try {
    const { userId, org_id } = req.user;
    const { id } = req.params;

    const participant = await ConversationParticipant.findOne({
      where: { conversation_id: id, user_id: userId, org_id, is_active: 1 },
    });
    if (!participant) {
      return sendResponse(res, 404, false, "Not a participant");
    }

    await participant.update({ is_favorite: participant.is_favorite ? 0 : 1 });
    sendResponse(res, 200, true, "Favorite toggled", { is_favorite: participant.is_favorite });
  } catch (error) {
    console.error("toggleFavorite error:", error.message);
    sendResponse(res, 500, false, "Failed to toggle favorite");
  }
};

// PUT /conversations/:id/mute — toggle mute
const toggleMute = async (req, res) => {
  try {
    const { userId, org_id } = req.user;
    const { id } = req.params;

    const participant = await ConversationParticipant.findOne({
      where: { conversation_id: id, user_id: userId, org_id, is_active: 1 },
    });
    if (!participant) {
      return sendResponse(res, 404, false, "Not a participant");
    }

    await participant.update({ is_muted: participant.is_muted ? 0 : 1 });
    sendResponse(res, 200, true, "Mute toggled", { is_muted: participant.is_muted });
  } catch (error) {
    console.error("toggleMute error:", error.message);
    sendResponse(res, 500, false, "Failed to toggle mute");
  }
};

// GET /conversations/:id/activity-log — paginated activity log
const getActivityLog = async (req, res) => {
  try {
    const { org_id } = req.user;
    const { id } = req.params;
    const { page = 1, limit = 30 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const logs = await ConversationActivityLog.findAndCountAll({
      where: { conversation_id: id, org_id },
      order: [["created_at", "DESC"]],
      limit: parseInt(limit),
      offset,
    });

    sendResponse(res, 200, true, "Activity log", {
      logs: logs.rows,
      total: logs.count,
      page: parseInt(page),
    });
  } catch (error) {
    console.error("getActivityLog error:", error.message);
    sendResponse(res, 500, false, "Failed to fetch activity log");
  }
};

module.exports = {
  getConversations,
  createConversation,
  getConversationById,
  updateConversation,
  leaveConversation,
  addMembers,
  removeMember,
  changeRole,
  toggleFavorite,
  toggleMute,
  getActivityLog,
};
