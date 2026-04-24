const dotenv = require("dotenv");
dotenv.config();
const express = require("express");
const http = require("http");
const cors = require("cors");
const conversationRoutes = require("./routes/conversationRoutes");
const messageRoutes = require("./routes/messageRoutes");
const searchRoutes = require("./routes/searchRoutes");
const { initSocket } = require("./socket/index");
const { fanoutQueue, maintenanceQueue, addUnreadFlushJob } = require("./jobs/queue");
const processMessageFanout = require("./jobs/messageFanout");
const processUnreadFlush = require("./jobs/unreadFlush");
const db = require("./models");

const app = express();
const server = http.createServer(app);

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE"],
    credentials: true,
  })
);

// Health check
app.get("/health", (req, res) => {
  res.status(200).json({
    message: "chat-service running ok",
    timestamp: new Date().toISOString(),
  });
});

// Routes
app.use("/conversations", conversationRoutes);
app.use("/conversations", messageRoutes);
// Also expose message-level routes (pin/star) at root so
// /messages/:id/pin and /messages/:id/star resolve correctly
// when the API gateway strips the /conversations prefix.
app.use("/", messageRoutes);
app.use("/search", searchRoutes);

// Initialize Socket.io
const io = initSocket(server);
global._io = io; // Used by jobs to emit socket events

// Initialize Bull queue processors (no-op if Redis unavailable)
if (fanoutQueue) fanoutQueue.process("messageFanout", 10, processMessageFanout);
if (maintenanceQueue) maintenanceQueue.process("unreadFlush", 1, processUnreadFlush);

// Schedule repeatable jobs
addUnreadFlushJob().catch((err) => {
  console.error("Failed to schedule unread flush job:", err.message);
});

// Start server
const PORT = process.env.PORT || 3012;
server.listen(PORT, () => {
  console.log(`Chat service running on port ${PORT}`);
});

module.exports = app;
