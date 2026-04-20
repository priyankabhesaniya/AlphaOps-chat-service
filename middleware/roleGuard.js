const { ConversationParticipant } = require("../models");

/**
 * Role guard middleware factory.
 * @param {number[]} allowedRoles - Array of allowed role values (1=owner, 2=admin, 3=member)
 */
const roleGuard = (allowedRoles = [1, 2]) => {
  return async (req, res, next) => {
    try {
      const conversationId = req.params.id || req.params.conversationId;
      const userId = req.user.userId;
      const orgId = Number(req.user.org_id);

      const participant = await ConversationParticipant.findOne({
        where: {
          conversation_id: conversationId,
          user_id: userId,
          org_id: orgId,
          is_active: 1,
        },
        attributes: ["role"],
      });

      if (!participant) {
        return res.status(403).json({ error: "Not a member of this conversation" });
      }

      if (!allowedRoles.includes(participant.role)) {
        return res.status(403).json({ error: "Insufficient permissions" });
      }

      req.participantRole = participant.role;
      next();
    } catch (error) {
      console.error("roleGuard error:", error.message);
      return res.status(500).json({ error: "Internal server error" });
    }
  };
};

module.exports = { roleGuard };
