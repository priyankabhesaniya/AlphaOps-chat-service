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
 * Returns { userId: { id, name, email, avatar_url, title, designation, about } }
 */
async function getUsersFromDb(userIds, orgId = null) {
  if (!userIds || userIds.length === 0) return {};
  try {
    const db = await getAuthSequelize();
    const orgFilter = orgId ? " AND u.org_id = :orgId" : "";
    const rows = await db.query(
      `SELECT
         u.id,
         u.username,
         u.first_name,
         u.last_name,
         u.email,
         u.avatar_url,
         u.role_id,
         r.name AS role_name
       FROM users u
       LEFT JOIN roles r
         ON r.id = u.role_id
        AND r.org_id = u.org_id
        AND r.is_deleted = 0
       WHERE u.id IN (:ids) AND u.is_deleted = 0${orgFilter}`,
      {
        replacements: { ids: userIds, orgId: orgId || undefined },
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
        role_id: r.role_id || null,
        title: r.role_name || "",
        designation: r.role_name || "",
        about: "",
      };
    }
    return map;
  } catch (err) {
    console.error("getUsersFromDb error:", err.message);
    return {};
  }
}

/**
 * Fetch ALL active (non-deleted) users for an organization.
 * Returns an array of user IDs.
 */
async function getOrgUserIdsFromDb(orgId) {
  if (!orgId) return [];
  try {
    const db = await getAuthSequelize();
    const rows = await db.query(
      `SELECT u.id
       FROM users u
       WHERE u.org_id = :orgId
         AND u.is_deleted = 0`,
      {
        replacements: { orgId },
        type: Sequelize.QueryTypes.SELECT,
      }
    );
    return rows.map((r) => r.id);
  } catch (err) {
    console.error("getOrgUserIdsFromDb error:", err.message);
    return [];
  }
}

module.exports = { getUsersFromDb, getOrgUserIdsFromDb };
