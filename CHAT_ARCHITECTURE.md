# Chat Service Architecture

## Message pagination

The chat service exposes `GET /conversations/:id/messages` for paginated message history.
Messages are loaded in descending `id` order and returned to the client in chronological order.

### Deleted messages

Server-side pagination accounts for messages marked as deleted for the current user:
- `message_deletions` records messages hidden from a specific user.
- The controller queries extra database rows and filters out deleted messages before responding.
- This prevents deleted rows from reducing the visible page size.

### Cursor strategy

- A `cursor` parameter is treated as the upper bound message ID.
- The backend continues loading older message batches until the requested page is filled or there are no more rows.
- The response includes `next_cursor` and `has_more` so the frontend can fetch earlier history.

## Database performance

The `messages` table is indexed for conversation-scoped history reads:
- `idx_conv_messages (conversation_id, id DESC)` supports queries by conversation and descending message ID.
- The table is partitioned by `created_at` for time-based storage management.

## Real-time sync

Socket.io is used for live chat updates, presence, typing, read receipts, and room membership.
- The frontend emits `rooms:sync` with the list of active conversation IDs.
- The socket server joins/leaves conversation rooms accordingly.
- New messages are broadcast to `conv:<conversationId>` rooms.
