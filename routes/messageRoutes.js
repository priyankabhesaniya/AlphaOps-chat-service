const express = require("express");
const router = express.Router();
const { authMiddleware } = require("../middleware/auth");
const { participantGuard } = require("../middleware/participantGuard");
const messageController = require("../controllers/messageController");

// Load messages (cursor-based)
router.get("/:id/messages", authMiddleware, participantGuard, messageController.getMessages);

// Thread replies
router.get("/:id/messages/:msgId/thread", authMiddleware, participantGuard, messageController.getThread);

// Message info (read receipts + reactions + edit history)
router.get("/:id/messages/:msgId/info", authMiddleware, participantGuard, messageController.getMessageInfo);

// Pinned messages
router.get("/:id/pinned", authMiddleware, participantGuard, messageController.getPinnedMessages);

// Toggle pin
router.put("/messages/:id/pin", authMiddleware, messageController.togglePin);

// File messages
router.get("/:id/files", authMiddleware, participantGuard, messageController.getFiles);

// Starred messages
router.get("/:id/starred", authMiddleware, participantGuard, messageController.getStarredMessages);

// Toggle star
router.put("/messages/:id/star", authMiddleware, messageController.toggleStar);

module.exports = router;
