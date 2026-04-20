"use strict";
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable("message_mentions", {
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
      conversation_id: {
        type: Sequelize.BIGINT,
        allowNull: false,
      },
      mentioned_user_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        comment: "NULL for @all",
      },
      mention_type: {
        type: Sequelize.TINYINT,
        allowNull: false,
        defaultValue: 1,
        comment: "1=user, 2=all",
      },
      org_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
      },
      created_at: {
        allowNull: false,
        type: Sequelize.DATE,
        defaultValue: Sequelize.NOW,
      },
    });

    await queryInterface.addIndex("message_mentions", ["mentioned_user_id", "org_id", "created_at"], {
      name: "idx_user_mentions",
    });
    await queryInterface.addIndex("message_mentions", ["message_id"], {
      name: "idx_msg_mentions",
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable("message_mentions");
  },
};
