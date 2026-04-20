const express = require("express");
const router = express.Router();
const { authMiddleware } = require("../middleware/auth");
const searchController = require("../controllers/searchController");

// Full-text search (optional conversation_id param for scoped search)
router.get("/", authMiddleware, searchController.searchMessages);

module.exports = router;
