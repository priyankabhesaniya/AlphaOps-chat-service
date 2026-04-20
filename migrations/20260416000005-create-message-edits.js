"use strict";
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable("message_edits", {
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
      org_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
      },
      previous_content: {
        type: Sequelize.TEXT,
        allowNull: false,
      },
      edited_by: {
        type: Sequelize.INTEGER,
        allowNull: false,
      },
      edited_at: {
        type: Sequelize.DATE,
        allowNull: false,
      },
    });

    await queryInterface.addIndex("message_edits", ["message_id", "edited_at"], {
      name: "idx_msg_edits",
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable("message_edits");
  },
};
