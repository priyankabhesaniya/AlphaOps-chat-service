const { Sequelize, DataTypes, Op } = require("sequelize");

let sequelize;

async function getAuthSequelize() {
  if (sequelize) return sequelize;
  sequelize = new Sequelize(
    process.env.AUTH_DB_NAME || "auth_db",
    process.env.AUTH_DB_USER || process.env.DB_USER || "root",
    process.env.AUTH_DB_PASSWORD || process.env.DB_PASSWORD || "wings123",
    {
      host: process.env.AUTH_DB_HOST || process.env.DB_HOST || "localhost",
      dialect: "mysql",
      logging: false,
    }
  );
  return sequelize;
}

/**
 * Fetch users from auth_db.users table by IDs.
 * Returns { userId: { id, name, email, avatar_url, title } }
 */
async function getUsersFromDb(userIds) {
  if (!userIds || userIds.length === 0) return {};
  try {
    const db = await getAuthSequelize();
    const rows = await db.query(
      `SELECT id, username, first_name, last_name, email, avatar_url
       FROM users
       WHERE id IN (:ids) AND is_deleted = 0`,
      {
        replacements: { ids: userIds },
        type: Sequelize.QueryTypes.SELECT,
      }
    );
    const map = {};
    for (const r of rows) {
      const name = [r.first_name, r.last_name].filter(Boolean).join(" ") || r.username;
      map[r.id] = {
        user_id: r.id,
        id: r.id,
        name,
        username: r.username,
        email: r.email,
        avatar_url: r.avatar_url,
      };
    }
    return map;
  } catch (err) {
    console.error("getUsersFromDb error:", err.message);
    return {};
  }
}

module.exports = { getUsersFromDb };
