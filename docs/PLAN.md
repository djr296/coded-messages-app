# Build Plan

## Current status (completed)

- Electron desktop shell
- Express backend running locally inside app startup
- SQLite persistence using `sql.js`
- Register/login with email/password
- Profile update (username, profile image path)
- Friend requests by username + accept flow
- 1:1 conversation creation and message persistence
- Coded display in chat + decrypter tab

## Next phase (recommended)

1. Realtime updates with Socket.IO
2. Add avatar file picker/upload flow (not just path)
3. Message search and conversation previews
4. Add real encryption under the hood (E2EE), keep coded display for shoulder-surfing
5. Packaging and installer for distribution

## Encryption recommendation

- Keep coded display as the UI layer.
- Add true crypto for storage/transport security.
- Suggested future approach: per-conversation key material + libsodium.
