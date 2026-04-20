const { DataTypes } = require('sequelize');
const { sequelizeWrite } = require('../config/database');

const MessageEdit = sequelizeWrite.define('MessageEdit', {
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
  org_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  previous_content: {
    type: DataTypes.TEXT,
    allowNull: false,
  },
  edited_by: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  edited_at: {
    type: DataTypes.DATE,
    allowNull: false,
  },
}, {
  tableName: 'message_edits',
  timestamps: false,
});

module.exports = MessageEdit;
