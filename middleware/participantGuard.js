const { ConversationParticipant } = require("../models");
const { getParticipantIds } = require("../redis/cacheService");

/**
 * Middleware to verify the requesting user is an active participant of the conversation.
 * Expects req.params.id or req.params.conversationId as the conversation ID.
 */
const participantGuard = async (req, res, next) => {
  try {
    const conversationId = req.params.id || req.params.conversationId;
    const userId = req.user.userId;
    const orgId = Number(req.user.org_id);

    if (!conversationId) {
      return res.status(400).json({ error: "Conversation ID is required" });
    }

    // Check Redis cache first
    const cachedParticipants = await getParticipantIds(conversationId);
    if (cachedParticipants) {
      if (cachedParticipants.includes(userId)) {
        return next();
      }
      return res.status(403).json({ error: "Not a member of this conversation" });
    }

    // Fallback to DB
    const participant = await ConversationParticipant.findOne({
      where: {
        conversation_id: conversationId,
        user_id: userId,
        org_id: orgId,
        is_active: 1,
      },
      attributes: ["id"],
    });

    if (!participant) {
      return res.status(403).json({ error: "Not a member of this conversation" });
    }

    next();
  } catch (error) {
    console.error("participantGuard error:", error.message);
    return res.status(500).json({ error: "Internal server error" });
  }
};

module.exports = { participantGuard };
