/**
 * Shared in-memory store: userId (string) → Set<socketId>
 *
 * Extracted into its own module so that both socket/index.js and
 * jobs/messageFanout.js can import it without creating a circular
 * dependency between those two files.
 */

// Map<string, Set<string>>  userId → set of active socket IDs
const userSockets = new Map();

function getUserSockets(userId) {
  return userSockets.get(String(userId)) || new Set();
}

module.exports = { userSockets, getUserSockets };
