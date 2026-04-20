const { DataTypes } = require('sequelize');
const { sequelizeWrite } = require('../config/database');

const ConversationParticipant = sequelizeWrite.define('ConversationParticipant', {
  id: {
    type: DataTypes.BIGINT,
    allowNull: false,
    autoIncrement: true,
    primaryKey: true,
  },
  conversation_id: {
    type: DataTypes.BIGINT,
    allowNull: false,
  },
  user_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  org_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  role: {
    type: DataTypes.TINYINT,
    allowNull: false,
    defaultValue: 3,
    comment: '1=owner, 2=admin, 3=member',
  },
  is_favorite: {
    type: DataTypes.TINYINT(1),
    allowNull: false,
    defaultValue: 0,
  },
  is_muted: {
    type: DataTypes.TINYINT(1),
    allowNull: false,
    defaultValue: 0,
  },
  unread_count: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
    comment: 'Snapshot from Redis, flushed every 5 min',
  },
  last_read_message_id: {
    type: DataTypes.BIGINT,
    allowNull: true,
    comment: 'Watermark: all msgs with id <= this are read',
  },
  last_read_at: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  joined_at: {
    type: DataTypes.DATE,
    allowNull: false,
  },
  left_at: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  is_active: {
    type: DataTypes.TINYINT(1),
    allowNull: false,
    defaultValue: 1,
  },
}, {
  tableName: 'conversation_participants',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  indexes: [
    { unique: true, fields: ['conversation_id', 'user_id'], name: 'uq_conv_user' },
  ],
});

module.exports = ConversationParticipant;
