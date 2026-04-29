"use strict";
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable("message_deliveries", {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: Sequelize.BIGINT,
      },
      message_id: {
        type: Sequelize.BIGINT,
        allowNull: false,
      },
      user_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
      },
      conversation_id: {
        type: Sequelize.BIGINT,
        allowNull: false,
      },
      org_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
      },
      delivered_at: {
        type: Sequelize.DATE(3),
        allowNull: false,
        defaultValue: Sequelize.NOW,
      },
    });

    await queryInterface.addIndex("message_deliveries", ["message_id", "user_id"], {
      unique: true,
      name: "uq_msg_delivery",
    });
    await queryInterface.addIndex("message_deliveries", ["message_id"], {
      name: "idx_delivery_message",
    });
    await queryInterface.addIndex("message_deliveries", ["conversation_id", "user_id"], {
      name: "idx_delivery_conv_user",
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable("message_deliveries");
  },
};
