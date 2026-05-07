const {
  Conversation,
  ConversationParticipant,
  ConversationActivityLog,
  Message,
} = require("../models");
const { sendResponse } = require("../utils/responseUtils");
const { invalidateParticipants, setParticipantIds, getCachedUsers, getOnlineUsers } = require("../redis/cacheService");
const { getAllUnreads, removeConversationUnread } = require("../redis/unreadService");
const { isConnected: isRedisConnected } = require("../redis/client");
const { Op } = require("sequelize");
const { sequelizeWrite } = require("../config/database");
const { addMessageFanoutJob } = require("../jobs/queue");
const { getUserSockets } = require("../socket/userSocketStore");
const { getUsersFromDb, getOrgUserIdsFromDb } = require("../utils/getUsersFromDb");

function emitNewMessage(conversationId, message) {
  try {
    global._io?.to?.(`conv:${conversationId}`)?.emit?.("message:new", message);
  } catch (e) {
    // ignore socket emit failures (API should still succeed)
  }
}

function emitConversationRemovedToUser({ userId, conversationId, reason }) {
  try {
    global._io?.to?.(`user:${userId}`)?.emit?.("conversation:removed", {
      conversation_id: conversationId,
      reason: reason || "removed",
    });
  } catch (_e) {
    // best effort
  }
}

function emitConversationCreatedToUsers(conversation, userIds) {
  if (!Array.isArray(userIds) || userIds.length === 0) return;

  const payload = {
    id: conversation.id,
    type: conversation.type,
    title: conversation.title,
    avatar_url: conversation.avatar_url,
    group_type: conversation.group_type,
    is_read_only: conversation.is_read_only,
    allow_read_receipts: conversation.allow_read_receipts,
    last_message_id: conversation.last_message_id,
    last_message_at: conversation.last_message_at ? conversation.last_message_at.toISOString() : null,
    last_message_preview: conversation.last_message_preview,
    last_message_sender_id: conversation.last_message_sender_id,
    created_by: conversation.created_by,
    created_at: conversation.created_at ? conversation.created_at.toISOString() : null,
    participant_count: conversation.participant_count || 0,
    members: conversation.members || [],
  };

  for (const uid of userIds) {
    const sockets = getUserSockets(uid);
    for (const socketId of sockets) {
      const socketInstance = global._io?.sockets?.sockets?.get(socketId);
      if (socketInstance) {
        socketInstance.emit("conversation:created", payload);
      }
    }
  }
}

async function fanoutSystemMessage({ message, conversation_id, org_id, sender_id, system_action }) {
  // For system messages, we still want unread counts, conversation last message,
  // and offline push notifications to work. We pass a preview string via `content`.
  const preview = system_action ? String(system_action).replace(/_/g, " ") : "system";
  await addMessageFanoutJob({
    message_id: message.id,
    conversation_id,
    org_id,
    sender_id,
    content: preview,
    kind: message.kind,
    parent_message_id: null,
    mentions: [],
  });
}

async function broadcastSystemMessages(conversationId, org_id, sender_id, sysMessages) {
  const list = Array.isArray(sysMessages) ? sysMessages.filter(Boolean) : (sysMessages ? [sysMessages] : []);
  for (const m of list) {
    emitNewMessage(conversationId, typeof m?.toJSON === "function" ? m.toJSON() : m);
    await fanoutSystemMessage({
      message: m,
      conversation_id: conversationId,
      org_id,
      sender_id,
      system_action: m.system_action,
    });
  }
}

async function createMemberAddedSystemMessages({
  conversationId,
  org_id,
  actorId,
  targetUserIds,
  transaction,
  combine = true,
}) {
  const ids = (Array.isArray(targetUserIds) ? targetUserIds : [targetUserIds])
    .map((n) => parseInt(n, 10))
    .filter((n) => Number.isFinite(n))
    .filter((n) => String(n) !== String(actorId));

  if (ids.length === 0) return [];

  const [cachedUsers, cachedActor] = await Promise.all([
    getCachedUsers(ids),
    getCachedUsers([actorId]),
  ]);
  const actorName =
    cachedActor[actorId]?.name
    || cachedActor[actorId]?.full_name
    || cachedActor[actorId]?.first_name
    || `User ${actorId}`;

  for (const uid of ids) {
    await ConversationActivityLog.create(
      { conversation_id: conversationId, org_id, actor_id: actorId, action: "member_added", target_user_id: uid },
      { transaction }
    );
  }

  const resolveName = (uid) =>
    cachedUsers[uid]?.name
    || cachedUsers[uid]?.full_name
    || cachedUsers[uid]?.first_name
    || `User ${uid}`;

  if (combine) {
    const nameList = ids.map(resolveName).join(", ");
    const sysMsg = await Message.create(
      {
        conversation_id: conversationId,
        org_id,
        sender_id: actorId,
        kind: 3,
        content: `${actorName} added ${nameList}`,
        system_action: "member_added",
      },
      { transaction }
    );
    return [sysMsg];
  }

  const out = [];
  for (const uid of ids) {
    const sysMsg = await Message.create(
      {
        conversation_id: conversationId,
        org_id,
        sender_id: actorId,
        kind: 3,
        content: `${actorName} added ${resolveName(uid)}`,
        system_action: "member_added",
      },
      { transaction }
    );
    out.push(sysMsg);
  }
  return out;
}

async function joinUsersToConversationRoom(conversationId, userIds) {
  const io = global._io;
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

async function leaveUsersFromConversationRoom(conversationId, userIds) {
  const io = global._io;
  if (!io || !Array.isArray(userIds) || userIds.length === 0) return;
  const adapter = io.of("/").adapter;

  for (const uid of userIds) {
    const sockets = getUserSockets(uid);
    for (const socketId of sockets) {
      const socket = io.sockets.sockets.get(socketId);
      if (socket) {
        socket.leave(`conv:${conversationId}`);
      } else if (typeof adapter.remoteLeave === "function") {
        try {
          await adapter.remoteLeave(socketId, `conv:${conversationId}`);
        } catch (_err) {
          // best effort
        }
      }
    }
  }
}

// GET /conversations — list user's conversations
const getConversations = async (req, res) => {
  try {
    const { userId, org_id } = req.user;
    const { page = 1, limit = 50 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const participants = await ConversationParticipant.findAll({
      where: {
        user_id: userId,
        org_id,
        is_active: 1,
        [Op.and]: [
          // Hide conversations that the user soft-deleted, until a new message arrives.
          sequelizeWrite.literal(
            "(`ConversationParticipant`.`hidden_last_message_id` IS NULL OR `conversation`.`last_message_id` > `ConversationParticipant`.`hidden_last_message_id`)"
          ),
        ],
      },
      include: [
        {
          model: Conversation,
          as: "conversation",
          where: { is_deleted: 0 },
          attributes: [
            "id", "type", "title", "avatar_url", "group_type", "is_read_only",
            "allow_read_receipts",
            "last_message_id", "last_message_at",
            "last_message_preview", "last_message_sender_id",
            "created_by", "created_at",
          ],
        },
      ],
      attributes: [
        "conversation_id",
        "role",
        "is_favorite",
        "is_muted",
        "last_read_message_id",
        "unread_count",
        "hidden_last_message_id",
        "hidden_at",
      ],
      order: [
        ["is_favorite", "DESC"],
        [sequelizeWrite.literal("CASE WHEN `conversation`.`last_message_at` IS NULL THEN 1 ELSE 0 END"), "ASC"],
        [{ model: Conversation, as: "conversation" }, "last_message_at", "DESC"],
      ],
      limit: parseInt(limit),
      offset,
    });

    // Fetch unread counts from Redis. If Redis is unavailable, use DB snapshot.
    const redisAvailable = isRedisConnected();
    const unreads = redisAvailable ? await getAllUnreads(userId) : {};

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
    const onlineUserIds = await getOnlineUsers(org_id, allUserIds);
    const onlineSet = new Set(onlineUserIds.map((id) => String(id)));
    const withPresence = (u) => {
      if (!u) return null;
      const uid = String(u.user_id || u.id);
      return { ...u, is_online: onlineSet.has(uid) };
    };

    const conversations = participants.map((p) => {
      const conv = p.conversation.toJSON();
      const participantCount = countMap[conv.id] || 0;

      // For DMs, set title and avatar_url to the other user's info
      let title = conv.title;
      let avatarUrl = conv.avatar_url;
      let otherUserId = null;
      let otherUser = null;
      if (conv.type === 1) {
        otherUserId = dmOtherUserMap[conv.id] || null;
        otherUser = otherUserId ? withPresence(userMap[otherUserId]) : null;
        title = otherUser?.name || `User ${otherUserId || ""}`;
        avatarUrl = otherUser?.avatar_url || null;
      }

      return {
        ...conv,
        title,
        avatar_url: avatarUrl,
        role: p.role,
        is_favorite: p.is_favorite,
        is_muted: p.is_muted,
        last_read_message_id: p.last_read_message_id,
        unread_count: redisAvailable
          ? (unreads[String(conv.id)] || 0)
          : (p.unread_count || 0),
        last_message_sender: withPresence(userMap[conv.last_message_sender_id]) || null,
        other_user_id: conv.type === 1 ? otherUserId : null,
        other_user: conv.type === 1 ? otherUser : null,
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
    const {
      type,
      title,
      description,
      avatar_url,
      groupType,
      group_type,
      is_read_only,
    } = req.body;

    // Accept both legacy and new keys from frontend
    const rawParticipants =
      req.body.participants ||
      req.body.participant_ids ||
      req.body["participants[]"] ||
      [];

    const participant_ids = Array.isArray(rawParticipants)
      ? rawParticipants
      : (rawParticipants ? [rawParticipants] : []);

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

    // Group validations + defaults
    const resolvedGroupType = String(groupType || group_type || "private").toLowerCase();
    const resolvedReadOnly = Boolean(is_read_only === true || is_read_only === 1 || is_read_only === "1" || is_read_only === "true");
    if (type === 2) {
      if (!title || !String(title).trim()) {
        return sendResponse(res, 400, false, "title is required for group");
      }
      if (!["public", "private"].includes(resolvedGroupType)) {
        return sendResponse(res, 400, false, "Invalid groupType (public|private)");
      }
      if (resolvedGroupType === "private" && participant_ids.length < 1) {
        return sendResponse(res, 400, false, "Private group requires at least one other participant");
      }
    }

    // Create conversation
    const conversation = await Conversation.create(
      {
        org_id,
        type,
        title: type === 2 ? title : null,
        description: type === 2 ? description : null,
        avatar_url: type === 2 ? avatar_url : null,
        group_type: type === 2 ? resolvedGroupType : "private",
        is_read_only: type === 2 ? (resolvedReadOnly ? 1 : 0) : 0,
        created_by: userId,
      },
      { transaction: t }
    );

    // Add creator as owner
    let allParticipantIds = [];

    if (type === 2 && resolvedGroupType === "public") {
      // PUBLIC GROUP: backend is source of truth, auto-include all org users (non-deleted)
      allParticipantIds = await getOrgUserIdsFromDb(org_id);
    } else {
      // PRIVATE GROUP or DM: use provided participants
      allParticipantIds = participant_ids.map((id) => parseInt(id, 10)).filter((n) => Number.isFinite(n));
    }

    // Always include creator, de-dup
    allParticipantIds = Array.from(new Set([userId, ...allParticipantIds].map((n) => parseInt(n, 10)).filter((n) => Number.isFinite(n))));

    // Validate org consistency via auth-db (source of truth).
    if (type === 2) {
      const idSet = Array.from(new Set(allParticipantIds));
      const userMap = await getUsersFromDb(idSet, org_id);
      const validSet = new Set(Object.keys(userMap).map(String));

      // Ensure creator exists/active in org
      if (!validSet.has(String(userId))) {
        await t.rollback();
        return sendResponse(res, 400, false, "Creator is not an active user in this organization");
      }

      const invalid = idSet.filter((id) => !validSet.has(String(id)));
      if (invalid.length) {
        await t.rollback();
        return sendResponse(res, 400, false, `Invalid participants for org: ${invalid.slice(0, 10).join(", ")}`);
      }

      // For private groups, require at least one other participant
      if (resolvedGroupType === "private") {
        const others = idSet.filter((id) => String(id) !== String(userId));
        if (others.length < 1) {
          await t.rollback();
          return sendResponse(res, 400, false, "Private group requires at least one other participant");
        }
      }

      allParticipantIds = idSet;
    }

    // Default everyone to member; ensure ONLY creator is owner
    const participantRows = allParticipantIds.map((uid) => ({
      conversation_id: conversation.id,
      user_id: uid,
      org_id,
      role: 3,
      joined_at: new Date(),
    }));

    // Ensure creator is owner/admin
    for (const row of participantRows) {
      if (String(row.user_id) === String(userId)) {
        row.role = 1;
      }
    }

    await ConversationParticipant.bulkCreate(participantRows, { transaction: t });

    // System message for group creation
    let createdSysMsg = null;
    let memberAddedSysMsgs = [];
    if (type === 2) {
      const cachedActor = await getCachedUsers([userId]);
      const actorName =
        cachedActor[userId]?.name
        || cachedActor[userId]?.full_name
        || cachedActor[userId]?.first_name
        || `User ${userId}`;

      createdSysMsg = await Message.create(
        {
          conversation_id: conversation.id,
          org_id,
          sender_id: userId,
          kind: 3,
          content: `${actorName} created group`,
          system_action: "created_group",
        },
        { transaction: t }
      );

      // During creation we add participants in one request; to match the existing UX
      // of "add member" actions, we generate member_added system messages here too.
      const initialAddedIds = allParticipantIds.filter((id) => String(id) !== String(userId));
      if (initialAddedIds.length > 0) {
        const perUser = resolvedGroupType === "private";
        memberAddedSysMsgs = await createMemberAddedSystemMessages({
          conversationId: conversation.id,
          org_id,
          actorId: userId,
          targetUserIds: initialAddedIds,
          transaction: t,
          combine: !perUser,
        });
      }

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

    // Cache participant IDs and ensure live sockets join the new conversation room.
    await setParticipantIds(conversation.id, allParticipantIds);
    await joinUsersToConversationRoom(conversation.id, allParticipantIds);

    if (type === 2) {
      await broadcastSystemMessages(conversation.id, org_id, userId, [createdSysMsg, ...memberAddedSysMsgs]);
    }

    // Send a live event for active sockets so newly added/created conversations appear immediately.
    const eventPayload = {
      id: conversation.id,
      type: conversation.type,
      title: conversation.type === 1 ? null : conversation.title,
      avatar_url: conversation.type === 1 ? null : conversation.avatar_url,
      group_type: conversation.group_type,
      is_read_only: conversation.is_read_only,
      allow_read_receipts: conversation.allow_read_receipts,
      last_message_id: null,
      last_message_at: conversation.created_at ? conversation.created_at.toISOString() : null,
      last_message_preview: null,
      last_message_sender_id: null,
      created_by: conversation.created_by,
      created_at: conversation.created_at ? conversation.created_at.toISOString() : null,
      is_favorite: 0,
      is_muted: 0,
      role: 1,
      last_read_message_id: null,
      unread_count: 0,
      other_user_id: null,
      other_user: null,
      participant_count: allParticipantIds.length,
      members: allParticipantIds,
    };

    if (type === 1) {
      const otherUserId = participant_ids[0];
      eventPayload.other_user_id = otherUserId;

      const users = await getCachedUsers([otherUserId]);
      const otherUser = users[otherUserId] || null;
      if (otherUser) {
        const onlineIds = await getOnlineUsers(org_id, [otherUserId]);
        eventPayload.other_user = {
          ...otherUser,
          is_online: onlineIds.map(String).includes(String(otherUserId)),
        };
        eventPayload.title = otherUser.name || otherUser.full_name || otherUser.first_name || `User ${otherUserId}`;
        eventPayload.avatar_url = otherUser.avatar_url || null;
      } else {
        eventPayload.title = `User ${otherUserId}`;
      }
    }

    if (type === 2) {
      eventPayload.title = conversation.title || "Group chat";
      eventPayload.avatar_url = conversation.avatar_url || null;
    }

    try {
      global._io?.to(`conv:${conversation.id}`)?.emit?.("conversation:created", eventPayload);
    } catch (err) {
      console.error("conversation:created emit failed:", err.message);
    }

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
    const onlineUserIds = await getOnlineUsers(org_id, userIds);
    const onlineSet = new Set(onlineUserIds.map((id) => String(id)));

    const result = conversation.toJSON();
    result.participants = result.participants.map((p) => ({
      ...p,
      user: userMap[p.user_id]
        ? {
          ...userMap[p.user_id],
          is_online: onlineSet.has(String(userMap[p.user_id].user_id || userMap[p.user_id].id)),
        }
        : null,
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
    const { title, description, avatar_url, allow_read_receipts, groupType, group_type, is_read_only } = req.body;

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
    if (groupType !== undefined || group_type !== undefined) {
      const gt = String(groupType || group_type || "").toLowerCase();
      if (["public", "private"].includes(gt)) updates.group_type = gt;
    }
    if (is_read_only !== undefined) updates.is_read_only = (is_read_only === true || is_read_only === 1 || is_read_only === "1" || is_read_only === "true") ? 1 : 0;
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

// DELETE /conversations/:id/hide — per-user soft delete (hide until new messages arrive)
const hideConversation = async (req, res) => {
  try {
    const { userId, org_id } = req.user;
    const { id } = req.params;

    const conversation = await Conversation.findOne({
      where: { id, org_id, is_deleted: 0 },
      attributes: ["id", "last_message_id"],
      raw: true,
    });
    if (!conversation) {
      return sendResponse(res, 404, false, "Conversation not found");
    }

    const participant = await ConversationParticipant.findOne({
      where: { conversation_id: id, user_id: userId, org_id, is_active: 1 },
    });
    if (!participant) {
      return sendResponse(res, 404, false, "Not a participant");
    }

    // IMPORTANT: keep this NON-NULL so auto-restore logic (fanout) can detect
    // hidden_last_message_id < new_message_id and emit conversation:created.
    // When a conversation has no last_message_id yet, use 0 as the watermark.
    const lastMessageId = conversation.last_message_id != null ? conversation.last_message_id : 0;
    const now = new Date();

    await participant.update({
      hidden_last_message_id: lastMessageId,
      hidden_at: now,
      // Ensure unread starts from NEW messages only.
      last_read_message_id: lastMessageId,
      last_read_at: now,
      unread_count: 0,
    });

    await removeConversationUnread(userId, id);
    emitConversationRemovedToUser({ userId, conversationId: id, reason: "hidden" });

    sendResponse(res, 200, true, "Conversation hidden");
  } catch (error) {
    console.error("hideConversation error:", error.message);
    sendResponse(res, 500, false, "Failed to hide conversation");
  }
};

// DELETE /conversations/:id/all — admin/owner global soft delete for a group
const deleteConversationForAll = async (req, res) => {
  try {
    const { userId, org_id } = req.user;
    const { id } = req.params;

    const conversation = await Conversation.findOne({
      where: { id, org_id },
      attributes: ["id", "type", "is_deleted"],
    });
    if (!conversation) {
      return sendResponse(res, 404, false, "Conversation not found");
    }
    if (Number(conversation.type) !== 2) {
      return sendResponse(res, 400, false, "Delete for all is only available for groups");
    }
    if (Number(conversation.is_deleted) === 1) {
      return sendResponse(res, 400, false, "Conversation already deleted");
    }

    await conversation.update({
      is_deleted: 1,
      deleted_for_all_at: new Date(),
      deleted_for_all_by: userId,
    });

    const participantRows = await ConversationParticipant.findAll({
      where: { conversation_id: id, org_id, is_active: 1 },
      attributes: ["user_id"],
      raw: true,
    });
    const userIds = participantRows.map((r) => r.user_id);

    await invalidateParticipants(id);

    try {
      const payload = {
        conversation_id: id,
        deleted_by: userId,
      };

      if (process.env.CHAT_DEBUG_SOCKET === "1") {
        console.log("[chat] deleted_all emit", { conversation_id: id, user_count: userIds.length });
      }

      // Emit to the conversation room (for clients still subscribed)
      global._io?.to?.(`conv:${id}`)?.emit?.("conversation:deleted_all", payload);

      // Adapter-safe: also emit directly to each participant's user room.
      // This guarantees delivery even if the client left the conv room via rooms:sync.
      for (const uid of userIds) {
        global._io?.to?.(`user:${uid}`)?.emit?.("conversation:deleted_all", payload);
      }
    } catch (_err) {
      // best effort
    }

    // Leave rooms after emitting so connected clients don't miss the event.
    await leaveUsersFromConversationRoom(id, userIds);

    sendResponse(res, 200, true, "Conversation deleted for all");
  } catch (error) {
    console.error("deleteConversationForAll error:", error.message);
    sendResponse(res, 500, false, "Failed to delete conversation for all");
  }
};

// POST /conversations/:id/leave — leave group (member only)
const leaveGroup = async (req, res) => {
  try {
    const { userId, org_id } = req.user;
    const { id } = req.params;

    const conversation = await Conversation.findOne({
      where: { id, org_id, is_deleted: 0 },
      attributes: ["id", "type"],
      raw: true,
    });
    if (!conversation) {
      return sendResponse(res, 404, false, "Conversation not found");
    }
    if (Number(conversation.type) !== 2) {
      return sendResponse(res, 400, false, "Leave group is only available for groups");
    }

    const participant = await ConversationParticipant.findOne({
      where: { conversation_id: id, user_id: userId, org_id, is_active: 1 },
    });
    if (!participant) {
      return sendResponse(res, 404, false, "Not a participant");
    }
    if (Number(participant.role) !== 3) {
      return sendResponse(res, 403, false, "Only members can leave the group");
    }

    await participant.update({
      is_active: 0,
      left_at: new Date(),
      hidden_last_message_id: null,
      hidden_at: null,
    });
    await invalidateParticipants(id);
    await leaveUsersFromConversationRoom(id, [userId]);
    await removeConversationUnread(userId, id);

    await ConversationActivityLog.create({
      conversation_id: id, org_id, actor_id: userId, action: "left",
    });

    const cachedActor = await getCachedUsers([userId]);
    const actorName =
      cachedActor[userId]?.name
      || cachedActor[userId]?.full_name
      || cachedActor[userId]?.first_name
      || `User ${userId}`;

    const sysMsg = await Message.create({
      conversation_id: id,
      org_id,
      sender_id: userId,
      kind: 3,
      content: `${actorName} left the group`,
      system_action: "member_left",
    });

    emitNewMessage(id, sysMsg.toJSON());
    await fanoutSystemMessage({
      message: sysMsg,
      conversation_id: id,
      org_id,
      sender_id: userId,
      system_action: "member_left",
    });

    emitConversationRemovedToUser({ userId, conversationId: id, reason: "left" });
    sendResponse(res, 200, true, "Left group");
  } catch (error) {
    console.error("leaveGroup error:", error.message);
    sendResponse(res, 500, false, "Failed to leave group");
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
    await leaveUsersFromConversationRoom(id, [userId]);
    await removeConversationUnread(userId, id);

    // Log + system message
    await ConversationActivityLog.create({
      conversation_id: id, org_id, actor_id: userId, action: "left",
    });
    const sysMsg = await Message.create({
      conversation_id: id, org_id, sender_id: userId,
      kind: 3, system_action: "member_left",
    });
    emitNewMessage(id, sysMsg.toJSON());
    await fanoutSystemMessage({
      message: sysMsg,
      conversation_id: id,
      org_id,
      sender_id: userId,
      system_action: "member_left",
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

    const [sysMsg] = await createMemberAddedSystemMessages({
      conversationId: id,
      org_id,
      actorId: userId,
      targetUserIds: newUserIds,
      transaction: t,
      combine: true,
    });

    await t.commit();
    await invalidateParticipants(id);
    await joinUsersToConversationRoom(id, newUserIds);

    const participantRows = await ConversationParticipant.findAll({
      where: { conversation_id: id, is_active: 1 },
      attributes: ["user_id"],
      raw: true,
    });
    const activeParticipantIds = participantRows.map((row) => row.user_id);

    emitConversationCreatedToUsers(
      {
        ...conversation.toJSON(),
        participant_count: activeParticipantIds.length,
        members: activeParticipantIds,
      },
      newUserIds
    );

    await broadcastSystemMessages(id, org_id, userId, [sysMsg]);

    sendResponse(res, 200, true, "Members added", { added: newUserIds });
  } catch (error) {
    await t.rollback();
    console.error("addMembers error:", error.message);
    sendResponse(res, 500, false, "Failed to add members");
  }
};

// POST /conversations/:id/members/:userId/block — block member
const blockMember = async (req, res) => {
  try {
    const { userId: actorId, org_id } = req.user;
    const { id, userId: targetUserId } = req.params;

    const target = await ConversationParticipant.findOne({
      where: { conversation_id: id, user_id: targetUserId, org_id, is_active: 1 },
    });
    if (!target) {
      return sendResponse(res, 404, false, "User not in conversation");
    }

    // Cannot block owner
    if (target.role === 1) {
      return sendResponse(res, 400, false, "Cannot block conversation owner");
    }

    await target.update({ is_active: 0, left_at: new Date() });
    await invalidateParticipants(id);
    await leaveUsersFromConversationRoom(id, [targetUserId]);
    await removeConversationUnread(targetUserId, id);

    const [cachedTarget, cachedActor] = await Promise.all([
      getCachedUsers([targetUserId]),
      getCachedUsers([actorId]),
    ]);
    const targetName = cachedTarget[targetUserId]?.name || cachedTarget[targetUserId]?.full_name || cachedTarget[targetUserId]?.first_name || `User ${targetUserId}`;
    const actorName = cachedActor[actorId]?.name || cachedActor[actorId]?.full_name || cachedActor[actorId]?.first_name || `User ${actorId}`;
    await ConversationActivityLog.create({
      conversation_id: id, org_id, actor_id: actorId, action: "member_blocked", target_user_id: targetUserId,
    });
    const sysMsg = await Message.create({
      conversation_id: id,
      org_id,
      sender_id: actorId,
      kind: 3,
      content: `${actorName} blocked ${targetName}`,
      system_action: "member_blocked",
    });
    emitNewMessage(id, sysMsg.toJSON());
    await fanoutSystemMessage({
      message: sysMsg,
      conversation_id: id,
      org_id,
      sender_id: actorId,
      system_action: "member_blocked",
    });

    sendResponse(res, 200, true, "Member blocked");
  } catch (error) {
    console.error("blockMember error:", error.message);
    sendResponse(res, 500, false, "Failed to block member");
  }
};

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
    await leaveUsersFromConversationRoom(id, [targetUserId]);
    await removeConversationUnread(targetUserId, id);

    const [cachedTarget, cachedActor] = await Promise.all([
      getCachedUsers([targetUserId]),
      getCachedUsers([actorId]),
    ]);
    const targetName = cachedTarget[targetUserId]?.name || cachedTarget[targetUserId]?.full_name || cachedTarget[targetUserId]?.first_name || `User ${targetUserId}`;
    const actorName = cachedActor[actorId]?.name || cachedActor[actorId]?.full_name || cachedActor[actorId]?.first_name || `User ${actorId}`;
    await ConversationActivityLog.create({
      conversation_id: id, org_id, actor_id: actorId, action: "member_removed", target_user_id: targetUserId,
    });
    const sysMsg = await Message.create({
      conversation_id: id,
      org_id,
      sender_id: actorId,
      kind: 3,
      content: `${actorName} removed ${targetName}`,
      system_action: "member_removed",
    });
    emitNewMessage(id, sysMsg.toJSON());
    await fanoutSystemMessage({
      message: sysMsg,
      conversation_id: id,
      org_id,
      sender_id: actorId,
      system_action: "member_removed",
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
  hideConversation,
  deleteConversationForAll,
  leaveConversation,
  leaveGroup,
  addMembers,
  removeMember,
  blockMember,
  changeRole,
  toggleFavorite,
  toggleMute,
  getActivityLog,
};
