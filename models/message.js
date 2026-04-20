const { DataTypes } = require('sequelize');
const { sequelizeWrite } = require('../config/database');

const Message = sequelizeWrite.define('Message', {
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
  org_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  sender_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  parent_message_id: {
    type: DataTypes.BIGINT,
    allowNull: true,
    comment: 'Thread parent (Slack-style)',
  },
  thread_reply_count: {
    type: DataTypes.SMALLINT,
    allowNull: false,
    defaultValue: 0,
  },
  kind: {
    type: DataTypes.TINYINT,
    allowNull: false,
    comment: '1=text, 2=file, 3=system',
  },
  content: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
  file_reference_id: {
    type: DataTypes.STRING(255),
    allowNull: true,
  },
  file_name: {
    type: DataTypes.STRING(255),
    allowNull: true,
  },
  file_type: {
    type: DataTypes.STRING(50),
    allowNull: true,
  },
  file_size_bytes: {
    type: DataTypes.INTEGER.UNSIGNED,
    allowNull: true,
  },
  reply_to_message_id: {
    type: DataTypes.BIGINT,
    allowNull: true,
    comment: 'Inline quote reply (not thread)',
  },
  forwarded_from_id: {
    type: DataTypes.BIGINT,
    allowNull: true,
  },
  system_action: {
    type: DataTypes.STRING(50),
    allowNull: true,
    comment: 'created_group, member_added, member_removed, etc.',
  },
  is_pinned: {
    type: DataTypes.TINYINT(1),
    allowNull: false,
    defaultValue: 0,
  },
  is_edited: {
    type: DataTypes.TINYINT(1),
    allowNull: false,
    defaultValue: 0,
  },
  is_deleted: {
    type: DataTypes.TINYINT(1),
    allowNull: false,
    defaultValue: 0,
  },
  client_message_id: {
    type: DataTypes.CHAR(36),
    allowNull: true,
  },
}, {
  tableName: 'messages',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
});

module.exports = Message;
