const { DataTypes } = require('sequelize');
const { sequelizeWrite } = require('../config/database');

const MessageMention = sequelizeWrite.define('MessageMention', {
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
  mentioned_user_id: {
    type: DataTypes.INTEGER,
    allowNull: true,
    comment: 'NULL for @all',
  },
  mention_type: {
    type: DataTypes.TINYINT,
    allowNull: false,
    defaultValue: 1,
    comment: '1=user, 2=all',
  },
  org_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
}, {
  tableName: 'message_mentions',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: false,
});

module.exports = MessageMention;
