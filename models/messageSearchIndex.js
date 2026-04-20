const { DataTypes } = require('sequelize');
const { sequelizeWrite } = require('../config/database');

const MessageSearchIndex = sequelizeWrite.define('MessageSearchIndex', {
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
  conversation_id: {
    type: DataTypes.BIGINT,
    allowNull: false,
  },
  org_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  sender_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  content: {
    type: DataTypes.TEXT,
    allowNull: false,
  },
}, {
  tableName: 'message_search_index',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: false,
});

module.exports = MessageSearchIndex;
