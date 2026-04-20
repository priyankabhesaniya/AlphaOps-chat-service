const { setPresence, setTyping, removeTyping } = require("../redis/cacheService");

function setupPresenceHandler(io, socket) {
  const { userId, orgId } = socket;

  // Heartbeat — renew presence TTL
  socket.on("presence:ping", async () => {
    try {
      await setPresence(orgId, userId);
    } catch (err) {
      console.error("presence:ping error:", err.message);
    }
  });

  // Typing start — SET key with 3s TTL + broadcast to room
  socket.on("typing:start", async (data) => {
    try {
      const { conversation_id } = data;
      if (!conversation_id) return;

      await setTyping(conversation_id, userId);

      socket.to(`conv:${conversation_id}`).emit("typing:update", {
        conversation_id,
        user_id: userId,
        is_typing: true,
      });
    } catch (err) {
      console.error("typing:start error:", err.message);
    }
  });

  // Typing stop — explicit stop (client also auto-clears after 3s)
  socket.on("typing:stop", async (data) => {
    try {
      const { conversation_id } = data;
      if (!conversation_id) return;

      await removeTyping(conversation_id, userId);

      socket.to(`conv:${conversation_id}`).emit("typing:update", {
        conversation_id,
        user_id: userId,
        is_typing: false,
      });
    } catch (err) {
      console.error("typing:stop error:", err.message);
    }
  });
}

module.exports = setupPresenceHandler;
