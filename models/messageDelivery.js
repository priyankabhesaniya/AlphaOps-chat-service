const { DataTypes } = require('sequelize');
const { sequelizeWrite } = require('../config/database');

const MessageDelivery = sequelizeWrite.define('MessageDelivery', {
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
  delivered_at: {
    type: DataTypes.DATE(3),
    allowNull: false,
    defaultValue: DataTypes.NOW,
  },
}, {
  tableName: 'message_deliveries',
  timestamps: false,
  indexes: [
    { unique: true, fields: ['message_id', 'user_id'], name: 'uq_msg_delivery' },
    { fields: ['message_id'], name: 'idx_delivery_message' },
    { fields: ['conversation_id', 'user_id'], name: 'idx_delivery_conv_user' },
  ],
});

module.exports = MessageDelivery;
