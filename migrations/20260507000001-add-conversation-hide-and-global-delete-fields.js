"use strict";
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // Per-user soft delete/hide (reappears when new messages arrive)
    await queryInterface.addColumn("conversation_participants", "hidden_last_message_id", {
      type: Sequelize.BIGINT,
      allowNull: true,
      defaultValue: null,
    });
    await queryInterface.addColumn("conversation_participants", "hidden_at", {
      type: "DATETIME(3)",
      allowNull: true,
      defaultValue: null,
    });

    await queryInterface.addIndex(
      "conversation_participants",
      ["user_id", "org_id", "is_active", "hidden_last_message_id"],
      { name: "idx_user_convs_hidden" }
    );

    // Global soft delete metadata for groups ("Delete for all")
    await queryInterface.addColumn("conversations", "deleted_for_all_at", {
      type: "DATETIME(3)",
      allowNull: true,
      defaultValue: null,
    });
    await queryInterface.addColumn("conversations", "deleted_for_all_by", {
      type: Sequelize.INTEGER,
      allowNull: true,
      defaultValue: null,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn("conversations", "deleted_for_all_by");
    await queryInterface.removeColumn("conversations", "deleted_for_all_at");
    await queryInterface.removeIndex("conversation_participants", "idx_user_convs_hidden");
    await queryInterface.removeColumn("conversation_participants", "hidden_at");
    await queryInterface.removeColumn("conversation_participants", "hidden_last_message_id");
  },
};

