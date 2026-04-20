"use strict";
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable("conversations", {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: Sequelize.BIGINT,
      },
      org_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
      },
      type: {
        type: Sequelize.TINYINT,
        allowNull: false,
        comment: "1=dm, 2=group",
      },
      title: {
        type: Sequelize.STRING(255),
        allowNull: true,
      },
      description: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      avatar_url: {
        type: Sequelize.STRING(500),
        allowNull: true,
      },
      is_public: {
        type: Sequelize.TINYINT(1),
        allowNull: false,
        defaultValue: 0,
      },
      allow_read_receipts: {
        type: Sequelize.TINYINT(1),
        allowNull: false,
        defaultValue: 1,
      },
      last_message_id: {
        type: Sequelize.BIGINT,
        allowNull: true,
      },
      last_message_at: {
        type: "DATETIME(3)",
        allowNull: true,
      },
      last_message_preview: {
        type: Sequelize.STRING(200),
        allowNull: true,
      },
      last_message_sender_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
      },
      created_by: {
        type: Sequelize.INTEGER,
        allowNull: false,
      },
      is_deleted: {
        type: Sequelize.TINYINT(1),
        allowNull: false,
        defaultValue: 0,
      },
      created_at: {
        allowNull: false,
        type: Sequelize.DATE,
        defaultValue: Sequelize.NOW,
      },
      updated_at: {
        allowNull: false,
        type: Sequelize.DATE,
        defaultValue: Sequelize.NOW,
      },
    });

    await queryInterface.addIndex("conversations", ["org_id", "is_deleted"], {
      name: "idx_conv_org",
    });
    await queryInterface.addIndex("conversations", ["org_id", "type", "is_deleted"], {
      name: "idx_conv_org_type",
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable("conversations");
  },
};
