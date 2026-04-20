const { Sequelize, DataTypes } = require("sequelize");

const getOrgDetailsById = async (orgId) => {
  let orgDbConnection;
  try {
    orgDbConnection = new Sequelize(
      process.env.ORG_DB_NAME,
      process.env.ORG_DB_USER || process.env.DB_USER,
      process.env.ORG_DB_PASSWORD || process.env.DB_PASSWORD,
      {
        host: process.env.ORG_DB_HOST || process.env.DB_HOST,
        dialect: "mysql",
        logging: false,
      }
    );

    const Org = orgDbConnection.define(
      "Organization",
      {
        id: {
          type: DataTypes.INTEGER,
          allowNull: false,
          autoIncrement: true,
          primaryKey: true,
        },
        name: { type: DataTypes.STRING(255), allowNull: false },
        org_code: { type: DataTypes.STRING(255), allowNull: false },
        status: {
          type: DataTypes.ENUM("Pending", "Active", "Inactive", "On Hold"),
          allowNull: false,
          defaultValue: "Pending",
        },
        is_deleted: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      },
      {
        tableName: "organizations",
        timestamps: false,
      }
    );

    const org = await Org.findOne({
      where: { id: orgId, is_deleted: false },
      attributes: ["id", "name", "org_code", "status"],
    });

    return org ? org.toJSON() : null;
  } catch (error) {
    console.error("Error fetching org details:", error.message);
    return null;
  } finally {
    if (orgDbConnection) {
      await orgDbConnection.close().catch(() => {});
    }
  }
};

module.exports = getOrgDetailsById;
