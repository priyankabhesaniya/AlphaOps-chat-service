const express = require("express");
const router = express.Router();
const { authMiddleware } = require("../middleware/auth");
const { getMentions } = require("../controllers/mentionController");

router.get("/", authMiddleware, getMentions);

module.exports = router;
