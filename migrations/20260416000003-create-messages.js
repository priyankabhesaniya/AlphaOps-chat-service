"use strict";
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // Create messages table with partitioning via raw SQL for RANGE COLUMNS support
    await queryInterface.sequelize.query(`
      CREATE TABLE messages (
        id BIGINT NOT NULL AUTO_INCREMENT,
        conversation_id BIGINT NOT NULL,
        org_id INT NOT NULL,
        sender_id INT NOT NULL,
        parent_message_id BIGINT NULL COMMENT 'Thread parent (Slack-style)',
        thread_reply_count SMALLINT NOT NULL DEFAULT 0,
        kind TINYINT NOT NULL COMMENT '1=text, 2=file, 3=system',
        content TEXT NULL,
        file_reference_id VARCHAR(255) NULL,
        file_name VARCHAR(255) NULL,
        file_type VARCHAR(50) NULL,
        file_size_bytes INT UNSIGNED NULL,
        reply_to_message_id BIGINT NULL COMMENT 'Inline quote reply',
        forwarded_from_id BIGINT NULL,
        system_action VARCHAR(50) NULL,
        is_pinned TINYINT(1) NOT NULL DEFAULT 0,
        is_edited TINYINT(1) NOT NULL DEFAULT 0,
        is_deleted TINYINT(1) NOT NULL DEFAULT 0,
        client_message_id CHAR(36) NULL,
        created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        PRIMARY KEY (id, created_at),
        INDEX idx_conv_messages (conversation_id, id DESC),
        INDEX idx_conv_thread (conversation_id, parent_message_id, id),
        INDEX idx_conv_pinned (conversation_id, is_pinned),
        INDEX idx_conv_files (conversation_id, kind, id DESC),
        INDEX idx_client_msg (client_message_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      PARTITION BY RANGE COLUMNS(created_at) (
        PARTITION p2026_01 VALUES LESS THAN ('2026-02-01'),
        PARTITION p2026_02 VALUES LESS THAN ('2026-03-01'),
        PARTITION p2026_03 VALUES LESS THAN ('2026-04-01'),
        PARTITION p2026_04 VALUES LESS THAN ('2026-05-01'),
        PARTITION p2026_05 VALUES LESS THAN ('2026-06-01'),
        PARTITION p2026_06 VALUES LESS THAN ('2026-07-01'),
        PARTITION p2026_07 VALUES LESS THAN ('2026-08-01'),
        PARTITION p2026_08 VALUES LESS THAN ('2026-09-01'),
        PARTITION p2026_09 VALUES LESS THAN ('2026-10-01'),
        PARTITION p2026_10 VALUES LESS THAN ('2026-11-01'),
        PARTITION p2026_11 VALUES LESS THAN ('2026-12-01'),
        PARTITION p2026_12 VALUES LESS THAN ('2027-01-01'),
        PARTITION p2027_01 VALUES LESS THAN ('2027-02-01'),
        PARTITION p2027_02 VALUES LESS THAN ('2027-03-01'),
        PARTITION p2027_03 VALUES LESS THAN ('2027-04-01'),
        PARTITION p_future VALUES LESS THAN (MAXVALUE)
      );
    `);
  },

  async down(queryInterface) {
    await queryInterface.dropTable("messages");
  },
};
