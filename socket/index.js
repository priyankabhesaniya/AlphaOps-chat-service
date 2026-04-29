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
      // Find the highest message_id already delivered by this user in this conversation
      const lastDelivered = await MessageDelivery.findOne({
        where: { conversation_id: convId, user_id: userId },
        order: [["message_id", "DESC"]],
        attributes: ["message_id"],
        raw: true,
      });
      const afterId = lastDelivered ? lastDelivered.message_id : 0;

      // Find undelivered messages (sent by others, newer than what was delivered, limit 100)
      const undelivered = await Message.findAll({
        where: {
          conversation_id: convId,
          sender_id: { [Op.ne]: userId },
          is_deleted: 0,
          id: { [Op.gt]: afterId },
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
    if (isConnected()) {
      const { createAdapter } = require("@socket.io/redis-adapter");
      const pubClient = redis.duplicate();
      const subClient = redis.duplicate();

      Promise.all([
        new Promise((resolve, reject) => {
          pubClient.on("connect", resolve);
          pubClient.on("error", reject);
        }),
        new Promise((resolve, reject) => {
          subClient.on("connect", resolve);
          subClient.on("error", reject);
        }),
      ])
        .then(() => {
          io.adapter(createAdapter(pubClient, subClient));
          console.log("Socket.io Redis adapter connected");
        })
        .catch((err) => {
          console.warn("Socket.io Redis adapter failed, running single-instance:", err.message);
        });
    } else {
      console.log("Socket.io running without Redis adapter (single-instance mode)");
    }
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
          where: { conversation_id: convIds, org_id: orgId, is_active: 1 },
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
        const currentRooms = [...socket.rooms].filter((room) => room.startsWith("conv:"));
        currentRooms.forEach((room) => {
          if (!desiredRooms.has(room)) {
            socket.leave(room);
          }
        });
        desiredRooms.forEach((room) => socket.join(room));

        // Send a fresh presence snapshot for the users visible through the newly synced rooms.
        if (requested.length > 0) {
          const peerRows = await ConversationParticipant.findAll({
            where: { conversation_id: requested, org_id: orgId, is_active: 1 },
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
