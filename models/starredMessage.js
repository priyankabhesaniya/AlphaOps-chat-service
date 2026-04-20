const { DataTypes } = require('sequelize');
const { sequelizeWrite } = require('../config/database');

const StarredMessage = sequelizeWrite.define('StarredMessage', {
  id: {
    type: DataTypes.BIGINT,
    allowNull: false,
    autoIncrement: true,
    primaryKey: true,
  },
  message_id: {
    type: DataTypes.BIGINT,
    allowNull: false,
  },
  user_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  conversation_id: {
    type: DataTypes.BIGINT,
    allowNull: false,
  },
  org_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
}, {
  tableName: 'starred_messages',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: false,
  indexes: [
    { unique: true, fields: ['message_id', 'user_id'], name: 'uq_star' },
  ],
});

module.exports = StarredMessage;
