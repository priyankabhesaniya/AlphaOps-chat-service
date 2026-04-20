const { DataTypes } = require('sequelize');
const { sequelizeWrite } = require('../config/database');

const Conversation = sequelizeWrite.define('Conversation', {
  id: {
    type: DataTypes.BIGINT,
    allowNull: false,
    autoIncrement: true,
    primaryKey: true,
  },
  org_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  type: {
    type: DataTypes.TINYINT,
    allowNull: false,
    comment: '1=dm, 2=group',
  },
  title: {
    type: DataTypes.STRING(255),
    allowNull: true,
  },
  description: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
  avatar_url: {
    type: DataTypes.STRING(500),
    allowNull: true,
  },
  is_public: {
    type: DataTypes.TINYINT(1),
    allowNull: false,
    defaultValue: 0,
  },
  allow_read_receipts: {
    type: DataTypes.TINYINT(1),
    allowNull: false,
    defaultValue: 1,
  },
  last_message_id: {
    type: DataTypes.BIGINT,
    allowNull: true,
  },
  last_message_at: {
    type: DataTypes.DATE(3),
    allowNull: true,
  },
  last_message_preview: {
    type: DataTypes.STRING(200),
    allowNull: true,
  },
  last_message_sender_id: {
    type: DataTypes.INTEGER,
    allowNull: true,
  },
  created_by: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  is_deleted: {
    type: DataTypes.TINYINT(1),
    allowNull: false,
    defaultValue: 0,
  },
}, {
  tableName: 'conversations',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
});

module.exports = Conversation;
