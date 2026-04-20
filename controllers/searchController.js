const { MessageSearchIndex, ConversationParticipant } = require("../models");
const { sendResponse } = require("../utils/responseUtils");
const { getCachedUsers } = require("../redis/cacheService");
const { sequelizeRead } = require("../config/database");

// GET /search — full-text search across messages
const searchMessages = async (req, res) => {
  try {
    const { userId, org_id } = req.user;
    const { q, conversation_id, cursor, limit = 20 } = req.query;

    if (!q || q.trim().length < 2) {
      return sendResponse(res, 400, false, "Search query must be at least 2 characters");
    }

    const queryLimit = Math.min(parseInt(limit), 50);
    const searchQuery = q.trim();

    let results;

    if (conversation_id) {
      // Scoped search: within a specific conversation
      const where = {
        org_id,
        conversation_id: parseInt(conversation_id),
      };

      let cursorFilter = "";
      const replacements = { orgId: org_id, convId: parseInt(conversation_id), query: searchQuery };

      if (cursor) {
        cursorFilter = "AND msi.id < :cursor";
        replacements.cursor = parseInt(cursor);
      }

      results = await sequelizeRead.query(
        `SELECT msi.id, msi.message_id, msi.conversation_id, msi.sender_id, msi.content, msi.created_at
         FROM message_search_index msi
         WHERE msi.org_id = :orgId AND msi.conversation_id = :convId
           AND MATCH(msi.content) AGAINST(:query IN BOOLEAN MODE)
           ${cursorFilter}
         ORDER BY msi.id DESC
         LIMIT :limit`,
        {
          replacements: { ...replacements, limit: queryLimit + 1 },
          type: sequelizeRead.QueryTypes.SELECT,
        }
      );
    } else {
      // Global search: across all user's conversations
      const replacements = { userId, orgId: org_id, query: searchQuery, limit: queryLimit + 1 };

      let cursorFilter = "";
      if (cursor) {
        cursorFilter = "AND msi.id < :cursor";
        replacements.cursor = parseInt(cursor);
      }

      results = await sequelizeRead.query(
        `SELECT msi.id, msi.message_id, msi.conversation_id, msi.sender_id, msi.content, msi.created_at
         FROM message_search_index msi
         JOIN conversation_participants cp ON cp.conversation_id = msi.conversation_id
           AND cp.user_id = :userId AND cp.is_active = 1
         WHERE msi.org_id = :orgId
           AND MATCH(msi.content) AGAINST(:query IN BOOLEAN MODE)
           ${cursorFilter}
         ORDER BY msi.id DESC
         LIMIT :limit`,
        {
          replacements,
          type: sequelizeRead.QueryTypes.SELECT,
        }
      );
    }

    const hasMore = results.length > queryLimit;
    const trimmed = results.slice(0, queryLimit);
    const nextCursor = trimmed.length > 0 ? trimmed[trimmed.length - 1].id : null;

    // Batch user lookup
    const senderIds = [...new Set(trimmed.map((r) => r.sender_id))];
    const userMap = await getCachedUsers(senderIds);

    const searchResults = trimmed.map((r) => ({
      ...r,
      sender: userMap[r.sender_id] || null,
    }));

    sendResponse(res, 200, true, "Search results", {
      results: searchResults,
      next_cursor: hasMore ? nextCursor : null,
      has_more: hasMore,
    });
  } catch (error) {
    console.error("searchMessages error:", error.message);
    sendResponse(res, 500, false, "Failed to search messages");
  }
};

module.exports = { searchMessages };
