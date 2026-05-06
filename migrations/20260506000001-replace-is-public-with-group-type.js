"use strict";
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // 1) Add new columns (nullable first for safe backfill)
    await queryInterface.addColumn("conversations", "group_type", {
      type: Sequelize.ENUM("public", "private"),
      allowNull: true,
      defaultValue: "private",
    });

    await queryInterface.addColumn("conversations", "is_read_only", {
      type: Sequelize.TINYINT(1),
      allowNull: false,
      defaultValue: 0,
    });

    // 2) Backfill group_type from is_public
    // Existing data: if is_public = 1 => public else private
    await queryInterface.sequelize.query(
      `UPDATE conversations
       SET group_type = CASE WHEN is_public = 1 THEN 'public' ELSE 'private' END
       WHERE group_type IS NULL`
    );

    // 3) Enforce NOT NULL after backfill
    await queryInterface.changeColumn("conversations", "group_type", {
      type: Sequelize.ENUM("public", "private"),
      allowNull: false,
      defaultValue: "private",
    });

    // 4) Drop old column
    await queryInterface.removeColumn("conversations", "is_public");

    // Helpful index for group filtering
    await queryInterface.addIndex("conversations", ["org_id", "type", "group_type", "is_deleted"], {
      name: "idx_conv_org_type_group_type",
    });
  },

  async down(queryInterface, Sequelize) {
    // Re-add is_public (default 0)
    await queryInterface.addColumn("conversations", "is_public", {
      type: Sequelize.TINYINT(1),
      allowNull: false,
      defaultValue: 0,
    });

    // Backfill is_public from group_type
    await queryInterface.sequelize.query(
      `UPDATE conversations
       SET is_public = CASE WHEN group_type = 'public' THEN 1 ELSE 0 END`
    );

    // Remove new columns/index
    try {
      await queryInterface.removeIndex("conversations", "idx_conv_org_type_group_type");
    } catch (_) {
      // ignore
    }
    await queryInterface.removeColumn("conversations", "group_type");
    await queryInterface.removeColumn("conversations", "is_read_only");

    // In MySQL, Sequelize ENUM cleanup is implicit with column drop.
    // (For Postgres, you'd need to drop the enum type explicitly.)
  },
};

