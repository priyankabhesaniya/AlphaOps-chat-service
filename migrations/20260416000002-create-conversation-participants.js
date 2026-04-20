"use strict";
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable("conversation_participants", {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: Sequelize.BIGINT,
      },
      conversation_id: {
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
      role: {
        type: Sequelize.TINYINT,
        allowNull: false,
        defaultValue: 3,
        comment: "1=owner, 2=admin, 3=member",
      },
      is_favorite: {
        type: Sequelize.TINYINT(1),
        allowNull: false,
        defaultValue: 0,
      },
      is_muted: {
        type: Sequelize.TINYINT(1),
        allowNull: false,
        defaultValue: 0,
      },
      unread_count: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      last_read_message_id: {
        type: Sequelize.BIGINT,
        allowNull: true,
      },
      last_read_at: {
        type: Sequelize.DATE,
        allowNull: true,
      },
      joined_at: {
        type: Sequelize.DATE,
        allowNull: false,
      },
      left_at: {
        type: Sequelize.DATE,
        allowNull: true,
      },
      is_active: {
        type: Sequelize.TINYINT(1),
        allowNull: false,
        defaultValue: 1,
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

    await queryInterface.addIndex("conversation_participants", ["conversation_id", "user_id"], {
      unique: true,
      name: "uq_conv_user",
    });
    await queryInterface.addIndex("conversation_participants", ["user_id", "org_id", "is_active", "is_favorite"], {
      name: "idx_user_convs",
    });
    await queryInterface.addIndex("conversation_participants", ["conversation_id", "is_active"], {
      name: "idx_conv_active",
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable("conversation_participants");
  },
};
