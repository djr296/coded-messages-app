# Build Plan

## Current status (completed)

- Electron desktop shell
- Express backend running locally inside app startup
- SQLite persistence using `sql.js`
- Register/login with email/password
- Cloud-synced profile update and image picker
- Friend requests with accept, decline, cancel, remove, block, and report controls
- 1:1 conversation creation and message persistence
- Group chat creation with friend invites
- 24-hour and never-expiring group invite links
- Creator-only group invite link revocation
- Coded display in chat + decrypter tab
- Plain-text send mode and timestamps
- Background multi-device synchronization
- Online and last-seen presence
- Image, PDF, and text attachments
- Persisted sessions with remote logout
- API rate limiting, structured logs, and health checks
- Automated API authorization/security tests

## Next phase (recommended)

1. Add group member management after creation
2. Add OS-level handling for `codedmessages://group/...` invite links
3. Add true push delivery with WebSockets instead of periodic synchronization
4. Move attachment storage from the database to managed object storage
5. Add message search, unread counts, and conversation previews
6. Add an administrator workflow for reviewing user reports
7. Add real encryption under the hood (E2EE), while keeping coded display as an optional visual mode

## Encryption recommendation

- Keep coded display as the UI layer.
- Add true crypto for storage/transport security.
- Suggested future approach: per-conversation key material + libsodium.
