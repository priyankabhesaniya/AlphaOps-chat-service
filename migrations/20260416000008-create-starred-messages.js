"use strict";
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable("starred_messages", {
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
      created_at: {
        allowNull: false,
        type: Sequelize.DATE,
        defaultValue: Sequelize.NOW,
      },
    });

    await queryInterface.addIndex("starred_messages", ["message_id", "user_id"], {
      unique: true,
      name: "uq_star",
    });
    await queryInterface.addIndex("starred_messages", ["user_id", "conversation_id", "created_at"], {
      name: "idx_user_stars",
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable("starred_messages");
  },
};
