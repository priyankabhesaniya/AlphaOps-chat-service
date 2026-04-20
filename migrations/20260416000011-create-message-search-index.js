"use strict";
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable("message_search_index", {
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
      org_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
      },
      sender_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
      },
      content: {
        type: Sequelize.TEXT,
        allowNull: false,
      },
      created_at: {
        allowNull: false,
        type: Sequelize.DATE,
        defaultValue: Sequelize.NOW,
      },
    });

    await queryInterface.addIndex("message_search_index", ["org_id", "conversation_id", "id"], {
      name: "idx_search_conv",
    });
    await queryInterface.addIndex("message_search_index", ["org_id", "id"], {
      name: "idx_search_org",
    });

    // Add FULLTEXT index via raw query (Sequelize doesn't support FULLTEXT directly)
    await queryInterface.sequelize.query(
      "ALTER TABLE message_search_index ADD FULLTEXT INDEX ft_content (content)"
    );
  },

  async down(queryInterface) {
    await queryInterface.dropTable("message_search_index");
  },
};
