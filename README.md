# Coded Messages App

Windows desktop chat app with account auth, friend requests, persisted direct and group conversations, coded-message display, optional plain-text sending, profiles, presence, and file attachments.

## Current Status

This project has a working Windows release with desktop install and Firebase-backed multi-device chat.

Email-based account features are temporarily out of scope for the current public release.

The current public release is focused on:

- account creation and login
- friend management
- coded/plain-text chat
- multi-device sync
- Windows install experience

The desktop app now uses Firebase Auth and Cloud Firestore directly for accounts, profiles, friends, blocks, reports, conversations, messages, and group invite links.

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
- Firebase-backed multi-device sync

## Download For Windows

Use the installer from the GitHub release page, not the green `Code` button on the repository.

1. Open the repository on GitHub.
2. On the right side, click `Releases`.
3. Open the latest release.
4. Under `Assets`, download the newest `Coded Messages Setup ...exe` installer version listed there.
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
- Cloud data: Firebase Cloud Firestore
- Auth: Firebase Auth
- Email: deferred for the current public release

## Project structure

- `main.js`: Electron main process
- `preload.js`: Secure renderer bridge (`codedApi`, `codedMessages`)
- `server/index.js`: legacy local/server API kept in the repo for reference and tests
- `server/index.test.js`: legacy API authorization and security regression tests
- `server/start.js`: legacy standalone backend entrypoint
- `server/mailer.js`: deferred email provider integration kept for future account-email work
- `docs/EMAIL_SETUP.md`: email provider overview and hosted setup notes
- `docs/GOOGLE_MAIL_WEBHOOK.md`: setup guide for the Google Apps Script mail webhook
- `docs/FIREBASE_MIGRATION.md`: Firebase migration plan and project notes
- `renderer/index.html`: UI markup
- `renderer/styles.css`: UI styles
- `renderer/app.js`: frontend logic
- `shared/codec.js`: obfuscation encode/decode logic
- `data/app.sqlite`: local app database (created at runtime in local mode)
