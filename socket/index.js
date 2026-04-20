const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");
const { redis, isConnected } = require("../redis/client");
const { ConversationParticipant } = require("../models");
const { setPresence, removePresence } = require("../redis/cacheService");
const setupMessageHandler = require("./messageHandler");
const setupPresenceHandler = require("./presenceHandler");
const setupReadHandler = require("./readHandler");

// Map: userId → Set<socketId>
const userSockets = new Map();

function getUserSockets(userId) {
  return userSockets.get(String(userId)) || new Set();
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

    // Join user to all their active conversation rooms
    try {
      const participations = await ConversationParticipant.findAll({
        where: { user_id: userId, org_id: orgId, is_active: 1 },
        attributes: ["conversation_id"],
        raw: true,
      });
      participations.forEach((p) => {
        socket.join(`conv:${p.conversation_id}`);
      });
    } catch (err) {
      console.error("Error joining rooms on connect:", err.message);
    }

    // Broadcast online status to org
    socket.broadcast.emit("presence:update", {
      user_id: userId,
      is_online: true,
    });

    // Setup event handlers
    setupMessageHandler(io, socket);
    setupPresenceHandler(io, socket);
    setupReadHandler(io, socket);

    // Disconnect
    socket.on("disconnect", async () => {
      const sockets = userSockets.get(userIdStr);
      if (sockets) {
        sockets.delete(socket.id);
        if (sockets.size === 0) {
          userSockets.delete(userIdStr);
          await removePresence(orgId, userId);
          socket.broadcast.emit("presence:update", {
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
