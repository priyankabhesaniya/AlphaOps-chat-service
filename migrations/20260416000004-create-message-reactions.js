"use strict";
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable("message_reactions", {
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
      org_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
      },
      emoji: {
        type: Sequelize.STRING(10),
        allowNull: false,
      },
      created_at: {
        allowNull: false,
        type: Sequelize.DATE,
        defaultValue: Sequelize.NOW,
      },
    });

    await queryInterface.addIndex("message_reactions", ["message_id", "user_id", "emoji"], {
      unique: true,
      name: "uq_reaction",
    });
    await queryInterface.addIndex("message_reactions", ["message_id"], {
      name: "idx_msg_reactions",
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable("message_reactions");
  },
};
