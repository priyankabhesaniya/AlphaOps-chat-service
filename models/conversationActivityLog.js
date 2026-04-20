const { DataTypes } = require('sequelize');
const { sequelizeWrite } = require('../config/database');

const ConversationActivityLog = sequelizeWrite.define('ConversationActivityLog', {
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
  actor_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  action: {
    type: DataTypes.STRING(30),
    allowNull: false,
    comment: 'created, member_added, member_removed, role_changed, title_changed, avatar_changed, left',
  },
  target_user_id: {
    type: DataTypes.INTEGER,
    allowNull: true,
  },
  metadata: {
    type: DataTypes.JSON,
    allowNull: true,
  },
}, {
  tableName: 'conversation_activity_logs',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: false,
});

module.exports = ConversationActivityLog;
