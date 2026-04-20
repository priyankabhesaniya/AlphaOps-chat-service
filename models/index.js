'use strict';

const Conversation = require('./conversation');
const ConversationParticipant = require('./conversationParticipant');
const Message = require('./message');
const MessageReaction = require('./messageReaction');
const MessageEdit = require('./messageEdit');
const MessageMention = require('./messageMention');
const MessageDeletion = require('./messageDeletion');
const StarredMessage = require('./starredMessage');
const ConversationActivityLog = require('./conversationActivityLog');
const UserCache = require('./userCache');
const MessageSearchIndex = require('./messageSearchIndex');
const { sequelizeWrite, sequelizeRead } = require('../config/database');

// Associations
Conversation.hasMany(ConversationParticipant, { foreignKey: 'conversation_id', as: 'participants' });
ConversationParticipant.belongsTo(Conversation, { foreignKey: 'conversation_id', as: 'conversation' });

Conversation.hasMany(Message, { foreignKey: 'conversation_id', as: 'messages' });
Message.belongsTo(Conversation, { foreignKey: 'conversation_id', as: 'conversation' });

Message.hasMany(MessageReaction, { foreignKey: 'message_id', as: 'reactions' });
MessageReaction.belongsTo(Message, { foreignKey: 'message_id', as: 'message' });

Message.hasMany(MessageEdit, { foreignKey: 'message_id', as: 'edits' });
MessageEdit.belongsTo(Message, { foreignKey: 'message_id', as: 'message' });

Message.hasMany(MessageMention, { foreignKey: 'message_id', as: 'mentions' });
MessageMention.belongsTo(Message, { foreignKey: 'message_id', as: 'message' });

Message.hasMany(MessageDeletion, { foreignKey: 'message_id', as: 'deletions' });
MessageDeletion.belongsTo(Message, { foreignKey: 'message_id', as: 'message' });

Message.hasMany(StarredMessage, { foreignKey: 'message_id', as: 'stars' });
StarredMessage.belongsTo(Message, { foreignKey: 'message_id', as: 'message' });

// Thread self-reference
Message.hasMany(Message, { foreignKey: 'parent_message_id', as: 'threadReplies' });
Message.belongsTo(Message, { foreignKey: 'parent_message_id', as: 'threadParent' });

// Reply-to self-reference
Message.belongsTo(Message, { foreignKey: 'reply_to_message_id', as: 'replyToMessage' });

Conversation.hasMany(ConversationActivityLog, { foreignKey: 'conversation_id', as: 'activityLogs' });
ConversationActivityLog.belongsTo(Conversation, { foreignKey: 'conversation_id', as: 'conversation' });

const db = {
  Conversation,
  ConversationParticipant,
  Message,
  MessageReaction,
  MessageEdit,
  MessageMention,
  MessageDeletion,
  StarredMessage,
  ConversationActivityLog,
  UserCache,
  MessageSearchIndex,
  sequelizeWrite,
  sequelizeRead,
};

module.exports = db;
