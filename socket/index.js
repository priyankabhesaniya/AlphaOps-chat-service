const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");
const { Op } = require("sequelize");
const { redis, isConnected } = require("../redis/client");
const { ConversationParticipant, Message, MessageDelivery } = require("../models");
const { setPresence, removePresence, getOnlineUsers, addMessageDelivery, getConversationParticipantIds } = require("../redis/cacheService");
const { setupMessageHandler, sendDeliveredEvent } = require("./messageHandler");
const setupPresenceHandler = require("./presenceHandler");
const setupReadHandler = require("./readHandler");
const { userSockets, getUserSockets } = require("./userSocketStore");

/**
 * For each conversation the newly connected user participates in, find messages
 * that were sent while they were offline (not yet in message_deliveries for this user)
 * and emit delivery events to those senders.
 * Fire-and-forget — never blocks the connect flow.
 */
async function reconcilePendingDeliveries(io, userId, orgId, participations) {
  if (!participations || participations.length === 0) return;

  const conversationIds = participations.map((p) => p.conversation_id);
  const now = new Date().toISOString();

  for (const convId of conversationIds) {
    try {
      // Visibility window enforcement (no hidden history replay on reconnect)
      const participant = await ConversationParticipant.findOne({
        where: { conversation_id: convId, user_id: userId, org_id: orgId, is_active: 1 },
        attributes: ["hidden_last_message_id", "joined_at"],
        raw: true,
      });
      if (!participant) continue;

      const hiddenLastMessageId =
        participant.hidden_last_message_id != null && participant.hidden_last_message_id !== ""
          ? Number(participant.hidden_last_message_id)
          : null;
      const joinedAt = participant.joined_at ? new Date(participant.joined_at) : null;
      const joinedAtValid = joinedAt && !Number.isNaN(joinedAt.getTime()) ? joinedAt : null;

      // Find the highest message_id already delivered by this user in this conversation
      const lastDelivered = await MessageDelivery.findOne({
        where: { conversation_id: convId, user_id: userId },
        order: [["message_id", "DESC"]],
        attributes: ["message_id"],
        raw: true,
      });
      const afterId = lastDelivered ? lastDelivered.message_id : 0;
      const minVisibleIdExclusive = Number.isFinite(hiddenLastMessageId)
        ? Math.max(Number(afterId || 0), Number(hiddenLastMessageId))
        : Number(afterId || 0);

      // Find undelivered messages (sent by others, newer than what was delivered, limit 100)
      const undelivered = await Message.findAll({
        where: {
          conversation_id: convId,
          sender_id: { [Op.ne]: userId },
          is_deleted: 0,
          id: { [Op.gt]: minVisibleIdExclusive },
          ...(joinedAtValid ? { created_at: { [Op.gte]: joinedAtValid } } : {}),
        },
        order: [["id", "DESC"]],
        limit: 100,
        attributes: ["id", "sender_id", "conversation_id", "client_message_id"],
        raw: true,
      });

      if (undelivered.length === 0) continue;

      // Get participant count for delivered_to_all computation
      const participantIds = await getConversationParticipantIds(convId, orgId);
      const recipientCount = Math.max(0, participantIds.length - 1);

      for (const msg of undelivered) {
        const delivery = { user_id: userId, delivered_at: now };
        await addMessageDelivery(msg.id, delivery, convId, orgId);
        // Notify senders by broadcasting the updated delivery state to the room
        await sendDeliveredEvent(io, convId, msg.id, recipientCount);
        // Replay full payload so the reconnecting recipient hydrates Redux without waiting for HTTP fetch
        try {
          const fullRow = await Message.findByPk(msg.id);
          if (fullRow) {
            io.to(`user:${userId}`).emit("message:new", fullRow.toJSON());
          }
        } catch (_e) {
          /* non-critical */
        }
      }
    } catch (err) {
      console.error(`[reconcile] conv ${convId}:`, err.message);
    }
  }
}

function initSocket(server) {
  const io = new Server(server, {
    cors: { origin: "*" },
    path: "/chat/socket.io",
    pingInterval: 25000,
    pingTimeout: 10000,
  });

  // Redis adapter for horizontal scaling (optional)
  try {
    // IMPORTANT: don't gate adapter setup on isConnected().
    // Redis client uses lazyConnect, so isConnected() is often false during startup
    // even when Redis is available, which would incorrectly disable the adapter.
    const { createAdapter } = require("@socket.io/redis-adapter");
    const pubClient = redis.duplicate();
    const subClient = redis.duplicate();

    // Avoid noisy/unhandled errors when Redis is down.
    // If adapter connect fails we continue in single-instance mode.
    pubClient.on("error", () => {});
    subClient.on("error", () => {});

    Promise.all([
      pubClient.connect(),
      subClient.connect(),
    ])
      .then(() => {
        io.adapter(createAdapter(pubClient, subClient));
        console.log("Socket.io Redis adapter connected");
      })
      .catch((err) => {
        console.warn("Socket.io Redis adapter failed, running single-instance:", err.message);
        try { pubClient.disconnect(); } catch (_) {}
        try { subClient.disconnect(); } catch (_) {}
      });
  } catch (err) {
    console.warn("Socket.io Redis adapter init error:", err.message);
  }

  // Auth middleware
  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token || socket.handshake.query?.token;
      if (!token) return next(new Error("Authentication required"));
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      socket.userId = decoded.userId;
      socket.orgId = Number(decoded.org_id);
      next();
    } catch (err) {
      next(new Error("Invalid token"));
    }
  });

  io.on("connection", async (socket) => {
    const { userId, orgId } = socket;
    const userIdStr = String(userId);

    // Track socket
    if (!userSockets.has(userIdStr)) {
      userSockets.set(userIdStr, new Set());
    }
    userSockets.get(userIdStr).add(socket.id);

    // Set presence
    await setPresence(orgId, userId);
    socket.join(`org:${orgId}`);
    // Per-user room for adapter-safe direct emits (works across instances)
    socket.join(`user:${userId}`);

    // Join user to all their active conversation rooms
    let participations = [];
    try {
      participations = await ConversationParticipant.findAll({
        where: { user_id: userId, org_id: orgId, is_active: 1 },
        attributes: ["conversation_id"],
        raw: true,
      });
      participations.forEach((p) => {
        socket.join(`conv:${p.conversation_id}`);
      });

      // Emit initial snapshot of online users visible to this user.
      const convIds = participations.map((p) => p.conversation_id);
      if (convIds.length > 0) {
        const peerRows = await ConversationParticipant.findAll({
          where: { conversation_id: convIds, org_id: orgId },
          attributes: ["user_id"],
          raw: true,
        });
        const visibleUserIds = [...new Set(peerRows.map((p) => p.user_id))];
        const onlineUserIds = await getOnlineUsers(orgId, visibleUserIds);
        socket.emit("presence:snapshot", {
          online_user_ids: onlineUserIds.map((id) => Number(id)),
          is_full_snapshot: false,
        });
      } else {
        socket.emit("presence:snapshot", {
          online_user_ids: [Number(userId)],
          is_full_snapshot: false,
        });
      }
    } catch (err) {
      console.error("Error joining rooms on connect:", err.message);
    }

    // Broadcast online status to org
    socket.to(`org:${orgId}`).emit("presence:update", {
      user_id: userId,
      is_online: true,
    });

    // Setup event handlers
    setupMessageHandler(io, socket);
    setupPresenceHandler(io, socket);
    setupReadHandler(io, socket);

    // Fire-and-forget: mark messages as delivered that arrived while this user was offline
    reconcilePendingDeliveries(io, userId, orgId, participations).catch((err) => {
      console.error("[reconcile] error:", err.message);
    });

    socket.on("rooms:sync", async (data) => {
      try {
        const requested = Array.isArray(data?.conversation_ids)
          ? data.conversation_ids.map((id) => String(id)).filter(Boolean)
          : [];
        const desiredRooms = new Set(requested.map((id) => `conv:${id}`));

        // Safety: never leave rooms for conversations this user still participates in.
        // UI visibility (or client bugs) must not break real-time delivery/read.
        let activeConvIdSet = null;
        try {
          const rows = await ConversationParticipant.findAll({
            where: { user_id: userId, org_id: orgId, is_active: 1 },
            attributes: ["conversation_id"],
            raw: true,
          });
          activeConvIdSet = new Set(rows.map((r) => String(r.conversation_id)));
        } catch (_err) {
          activeConvIdSet = null;
        }

        const currentRooms = [...socket.rooms].filter((room) => room.startsWith("conv:"));
        currentRooms.forEach((room) => {
          if (!desiredRooms.has(room)) {
            const convId = room.slice("conv:".length);
            if (activeConvIdSet && activeConvIdSet.has(String(convId))) {
              return;
            }
            socket.leave(room);
          }
        });
        desiredRooms.forEach((room) => socket.join(room));

        // Send a fresh presence snapshot for the users visible through the newly synced rooms.
        if (requested.length > 0) {
          const peerRows = await ConversationParticipant.findAll({
            where: { conversation_id: requested, org_id: orgId },
            attributes: ["user_id"],
            raw: true,
          });
          const visibleUserIds = [...new Set(peerRows.map((p) => p.user_id))];
          const onlineUserIds = await getOnlineUsers(orgId, visibleUserIds);
          socket.emit("presence:snapshot", {
            online_user_ids: onlineUserIds.map((id) => Number(id)),
            is_full_snapshot: false,
          });
        } else {
          socket.emit("presence:snapshot", {
            online_user_ids: [Number(userId)],
            is_full_snapshot: false,
          });
        }
      } catch (err) {
        console.error("rooms:sync error:", err.message);
      }
    });

    // Disconnect
    socket.on("disconnect", async () => {
      const sockets = userSockets.get(userIdStr);
      if (sockets) {
        sockets.delete(socket.id);
        if (sockets.size === 0) {
          userSockets.delete(userIdStr);
          await removePresence(orgId, userId);
          socket.to(`org:${orgId}`).emit("presence:update", {
            user_id: userId,
            is_online: false,
            last_seen_at: new Date().toISOString(),
          });
        }
      }
    });
  });

  return io;
}

module.exports = { initSocket, getUserSockets, userSockets };
