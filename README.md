# Coded Messages App

Windows desktop chat app with account auth, friend requests, persisted direct and group conversations, coded-message display, optional plain-text sending, profiles, presence, and file attachments.

## Current Status

This project is ready for the first public `v1.0.0` Windows release. The desktop app, installer, multi-device chat, and hosted backend are working.

Email-based account features are temporarily out of scope for `v1.0.0`.

The current public release target is focused on:

- account creation and login
- friend management
- coded/plain-text chat
- multi-device sync
- Windows install experience

## Features

- Email/password register + login
- Profile updates with local image picker + avatar display
- Friend requests by username
- Accept incoming requests
- Decline incoming requests
- Cancel outgoing requests
- Remove friend
- 1:1 conversations with persisted message history
- Group chats with friend invites
- Group invite links with 24-hour or never-expiring options
- Turn off all current group invite links
- Leave group chat
- Per-message send mode: `Encoded` or `Plain text`
- Message timestamps in chat
- Background multi-device message synchronization
- Online and last-seen presence
- Cloud-synced profile pictures
- Image, PDF, and text-file attachments
- Block and report controls
- Active-session management and remote logout
- Decrypter tab (paste coded text -> English)
- Cloud-hosted backend for multi-device use
- API rate limits, structured request logs, and database health checks

## Download For Windows

Use the installer from the GitHub release page, not the green `Code` button on the repository.

1. Open the repository on GitHub.
2. On the right side, click `Releases`.
3. Open the latest release.
4. Under `Assets`, download `Coded Messages Setup 1.0.0.exe` or the newest installer version listed there.
5. Run the installer.
6. If Windows shows a warning, click `More info` and then `Run anyway` if you trust the release source.
7. Finish installation and open `Coded Messages` from the Start menu or desktop shortcut.

If there is no published GitHub Release yet, the installer has not been posted publicly yet.

## For Testers

- The first request can be slow if the free cloud server is waking up.
- Password reset and welcome emails are not part of the current public release target.
- Existing local-only test accounts do not automatically appear in the cloud database.
- Attachments are limited to supported image formats, PDF, or plain text and a maximum of 2 MB.

## Tech stack

- Desktop: Electron
- API: Express
- Database:
  - Local mode: SQLite via `sql.js`
  - Hosted mode: Postgres
- Auth: JWT + bcryptjs
- Email: deferred for the current public release

## Project structure

- `main.js`: Electron main process + local API startup when not using a hosted backend
- `preload.js`: Secure renderer bridge (`codedApi`, `codedMessages`)
- `server/index.js`: Express API implementation for SQLite or Postgres
- `server/index.test.js`: automated API authorization and security regression tests
- `server/start.js`: standalone backend entrypoint
- `server/mailer.js`: deferred email provider integration kept for future account-email work
- `docs/EMAIL_SETUP.md`: email provider overview and hosted setup notes
- `docs/GOOGLE_MAIL_WEBHOOK.md`: setup guide for the Google Apps Script mail webhook
- `renderer/index.html`: UI markup
- `renderer/styles.css`: UI styles
- `renderer/app.js`: frontend logic
- `shared/codec.js`: obfuscation encode/decode logic
- `data/app.sqlite`: local app database (created at runtime in local mode)
