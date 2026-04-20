"use strict";
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable("message_deletions", {
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
      deleted_at: {
        type: Sequelize.DATE,
        allowNull: false,
      },
    });

    await queryInterface.addIndex("message_deletions", ["message_id", "user_id"], {
      unique: true,
      name: "uq_msg_del",
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable("message_deletions");
  },
};
