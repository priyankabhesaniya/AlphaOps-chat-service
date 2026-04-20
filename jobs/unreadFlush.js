const { ConversationParticipant } = require("../models");
const { getUnreadsForFlush } = require("../redis/unreadService");
const { sequelizeWrite } = require("../config/database");

/**
 * Periodic job: flush Redis unread counts to DB every 5 minutes.
 * DB is a crash-recovery snapshot, NOT the source of truth.
 *
 * Strategy:
 * - Get all users with data in Redis unread hashes
 * - For each user, batch-UPDATE conversation_participants with CASE/WHEN
 */
async function processUnreadFlush(job) {
  const startTime = Date.now();
  let totalUsers = 0;
  let totalUpdates = 0;

  try {
    // Get recently active participant records to know which users to flush
    // Only flush users who have been active in the last 10 minutes
    const activeParticipants = await ConversationParticipant.findAll({
      where: { is_active: 1 },
      attributes: [[sequelizeWrite.fn("DISTINCT", sequelizeWrite.col("user_id")), "user_id"]],
      raw: true,
      limit: 10000,
    });

    const userIds = activeParticipants.map((p) => p.user_id);

    for (const userId of userIds) {
      const unreads = await getUnreadsForFlush(userId);
      if (!unreads || Object.keys(unreads).length === 0) continue;

      totalUsers++;

      // Build batch update: single query per user using CASE/WHEN
      const convIds = Object.keys(unreads);
      const caseStatements = convIds
        .map((convId) => `WHEN conversation_id = ${parseInt(convId, 10)} THEN ${parseInt(unreads[convId], 10)}`)
        .join(" ");

      const escapedConvIds = convIds.map((id) => parseInt(id, 10)).join(",");

      const query = `
        UPDATE conversation_participants 
        SET unread_count = CASE ${caseStatements} ELSE unread_count END
        WHERE user_id = :userId AND conversation_id IN (${escapedConvIds}) AND is_active = 1
      `;

      await sequelizeWrite.query(query, {
        replacements: { userId },
        type: sequelizeWrite.QueryTypes.UPDATE,
      });

      totalUpdates += convIds.length;
    }

    const elapsed = Date.now() - startTime;
    console.log(`[unreadFlush] Flushed ${totalUpdates} counts for ${totalUsers} users in ${elapsed}ms`);
  } catch (error) {
    console.error("[unreadFlush] Error:", error.message);
    throw error; // Let Bull handle retry
  }
}

module.exports = processUnreadFlush;
