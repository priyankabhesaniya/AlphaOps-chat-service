const { DataTypes } = require('sequelize');
const { sequelizeWrite } = require('../config/database');

const UserCache = sequelizeWrite.define('UserCache', {
  user_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
    primaryKey: true,
  },
  org_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  name: {
    type: DataTypes.STRING(255),
    allowNull: false,
  },
  email: {
    type: DataTypes.STRING(255),
    allowNull: true,
  },
  title: {
    type: DataTypes.STRING(255),
    allowNull: true,
  },
  avatar_url: {
    type: DataTypes.STRING(500),
    allowNull: true,
  },
  cached_at: {
    type: DataTypes.DATE,
    allowNull: false,
  },
}, {
  tableName: 'user_cache',
  timestamps: false,
});

module.exports = UserCache;
