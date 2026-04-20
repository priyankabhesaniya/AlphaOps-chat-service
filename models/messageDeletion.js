const { DataTypes } = require('sequelize');
const { sequelizeWrite } = require('../config/database');

const MessageDeletion = sequelizeWrite.define('MessageDeletion', {
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
  org_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  deleted_at: {
    type: DataTypes.DATE,
    allowNull: false,
  },
}, {
  tableName: 'message_deletions',
  timestamps: false,
  indexes: [
    { unique: true, fields: ['message_id', 'user_id'], name: 'uq_msg_del' },
  ],
});

module.exports = MessageDeletion;
