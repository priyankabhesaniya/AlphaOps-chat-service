const { Sequelize, DataTypes, Op } = require("sequelize");

let sequelize; // shared connection instance

async function getSequelize() {
  if (sequelize) return sequelize;

  sequelize = new Sequelize(
    process.env.AUTH_DB_NAME || "auth_db",
    process.env.AUTH_DB_USER || process.env.DB_USER,
    process.env.AUTH_DB_PASSWORD || process.env.DB_PASSWORD,
    {
      host: process.env.AUTH_DB_HOST || process.env.DB_HOST,
      dialect: "mysql",
      logging: false,
    }
  );

  try {
    await sequelize.authenticate();
    console.log("Chat-service: Connected to AUTH DB");
  } catch (err) {
    console.error("Chat-service: AUTH DB connection error:", err.message);
    throw err;
  }

  return sequelize;
}

async function getBlacklistedTokenModel() {
  const db = await getSequelize();

  // Reuse existing defined model if available
  if (db.models && db.models.BlacklistedToken) {
    return db.models.BlacklistedToken;
  }

  const BlacklistedToken = db.define(
    "BlacklistedToken",
    {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
        allowNull: false,
      },
      token_jti: {
        type: DataTypes.STRING(255),
        allowNull: false,
        unique: true,
      },
      token_type: {
        type: DataTypes.ENUM("access", "refresh"),
        allowNull: false,
      },
      user_id: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      expires_at: {
        type: DataTypes.DATE,
        allowNull: false,
      },
      is_deleted: {
        type: DataTypes.TINYINT,
        allowNull: false,
        defaultValue: 0,
      },
      created_at: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
      },
      updated_at: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
      },
    },
    {
      tableName: "blacklisted_tokens",
      timestamps: true,
      underscored: true,
    }
  );

  // Static helper used by auth middleware
  BlacklistedToken.isTokenPresent = async function (jti) {
    try {
      const token = await this.findOne({
        where: {
          token_jti: jti,
          is_deleted: 0,
          expires_at: { [Op.gt]: new Date() },
        },
      });
      return !!token;
    } catch (error) {
      console.error("Error checking token presence:", error.message);
      return false;
    }
  };

  return BlacklistedToken;
}

module.exports = {
  getSequelize,
  getBlacklistedTokenModel,
};
