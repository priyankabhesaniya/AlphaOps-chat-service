"use strict";

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(
      "ALTER TABLE messages MODIFY COLUMN file_type VARCHAR(255) NULL;"
    );
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(
      "ALTER TABLE messages MODIFY COLUMN file_type VARCHAR(50) NULL;"
    );
  },
};
