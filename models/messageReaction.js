const { DataTypes } = require('sequelize');
const { sequelizeWrite } = require('../config/database');

const MessageReaction = sequelizeWrite.define('MessageReaction', {
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
  emoji: {
    type: DataTypes.STRING(10),
    allowNull: false,
  },
}, {
  tableName: 'message_reactions',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: false,
  indexes: [
    { unique: true, fields: ['message_id', 'user_id', 'emoji'], name: 'uq_reaction' },
  ],
});

module.exports = MessageReaction;
