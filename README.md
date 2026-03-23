# Coded Messages App

Windows desktop chat app with account auth, friend requests, persisted 1:1 conversations, coded-message display, and optional plain-text sending.

## Features

- Email/password register + login
- Welcome email on account creation
- Profile updates (username + profile image path)
- Friend requests by username
- Accept incoming requests
- 1:1 conversations with persisted message history
- Per-message send mode: `Encoded` or `Plain text`
- Decrypter tab (paste coded text -> English)
- Cloud-hosted backend for multi-device use

## Download For Windows

Use the installer from the GitHub release page, not the green `Code` button on the repository.

1. Open the repository on GitHub.
2. On the right side, click `Releases`.
3. Open the latest release.
4. Under `Assets`, download `Coded Messages Setup 0.2.0.exe` or the newest installer version listed there.
5. Run the installer.
6. If Windows shows a warning, click `More info` and then `Run anyway` if you trust the release source.
7. Finish installation and open `Coded Messages` from the Start menu or desktop shortcut.

If there is no published GitHub Release yet, the installer has not been posted publicly yet.

## For Testers

- The first request can be slow if the free cloud server is waking up.
- Welcome emails can take a minute and may land in spam/junk.
- Existing local-only test accounts do not automatically appear in the cloud database.

## Tech stack

- Desktop: Electron
- API: Express
- Database:
  - Local mode: SQLite via `sql.js`
  - Hosted mode: Postgres
- Auth: JWT + bcryptjs
- Email: Nodemailer via SMTP

## Local development

1. Open PowerShell in the project folder:

```powershell
cd "path\to\coded-messages-app"
```

2. Start the app:

```powershell
powershell -ExecutionPolicy Bypass -File ".\start-app.ps1"
```

## Standalone backend mode

Start the backend by itself:

```powershell
npm run server:start
```

Useful environment variables:

- `CODED_MESSAGES_HOST`: bind host for the API server. Default: `0.0.0.0`
- `PORT` or `CODED_MESSAGES_PORT`: API port. Default: `3847`
- `CODED_MESSAGES_DB_PATH`: local database file path
- `DATABASE_URL`: Postgres connection string for hosted databases such as Supabase
- `CODED_MESSAGES_API_BASE`: API URL the Electron app should use
- `SMTP_HOST`: SMTP server hostname for welcome emails
- `SMTP_PORT`: SMTP server port, usually `587` or `465`
- `SMTP_USER`: SMTP username
- `SMTP_PASS`: SMTP password or app password
- `SMTP_FROM`: sender email, for example `Coded Messages <no-reply@yourdomain.com>`

Example: run the app against an external server instead of the embedded local API:

```powershell
$env:CODED_MESSAGES_API_BASE="https://your-server-url"
npm start
```

## Test workflow

1. Create account A.
2. Create account B.
3. From B, send a friend request to A's username.
4. Log into A and accept the request in `Requests`.
5. Open the friend in `Friends` and send one `Encoded` message.
6. Send one `Plain text` message.
7. Confirm both devices display each message in the selected mode.
8. Use the `Decrypter` tab to decode pasted coded text.

## Project structure

- `main.js`: Electron main process + local API startup when not using a hosted backend
- `preload.js`: Secure renderer bridge (`codedApi`, `codedMessages`)
- `server/index.js`: Express API implementation for SQLite or Postgres
- `server/start.js`: standalone backend entrypoint
- `server/mailer.js`: SMTP mailer for welcome emails
- `renderer/index.html`: UI markup
- `renderer/styles.css`: UI styles
- `renderer/app.js`: frontend logic
- `shared/codec.js`: obfuscation encode/decode logic
- `data/app.sqlite`: local app database (created at runtime in local mode)
