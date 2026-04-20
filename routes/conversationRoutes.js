const express = require("express");
const router = express.Router();
const { authMiddleware } = require("../middleware/auth");
const { participantGuard } = require("../middleware/participantGuard");
const { roleGuard } = require("../middleware/roleGuard");
const conversationController = require("../controllers/conversationController");

// List conversations
router.get("/", authMiddleware, conversationController.getConversations);

// Create conversation (DM or group)
router.post("/", authMiddleware, conversationController.createConversation);

// Get conversation details + participants
router.get("/:id", authMiddleware, participantGuard, conversationController.getConversationById);

// Update group info (admin/owner)
router.put("/:id", authMiddleware, participantGuard, roleGuard([1, 2]), conversationController.updateConversation);

// Leave conversation
router.delete("/:id", authMiddleware, participantGuard, conversationController.leaveConversation);

// Add members (admin/owner)
router.post("/:id/members", authMiddleware, participantGuard, roleGuard([1, 2]), conversationController.addMembers);

// Remove member (admin/owner)
router.delete("/:id/members/:userId", authMiddleware, participantGuard, roleGuard([1, 2]), conversationController.removeMember);

// Change role (owner only for ownership transfer, admin for role changes)
router.put("/:id/members/:userId/role", authMiddleware, participantGuard, roleGuard([1, 2]), conversationController.changeRole);

// Toggle favorite
router.put("/:id/favorite", authMiddleware, participantGuard, conversationController.toggleFavorite);

// Toggle mute
router.put("/:id/mute", authMiddleware, participantGuard, conversationController.toggleMute);

// Activity log
router.get("/:id/activity-log", authMiddleware, participantGuard, conversationController.getActivityLog);

module.exports = router;
