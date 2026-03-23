# Coded Messages App

Windows desktop app with account auth, profile updates, friend requests, persisted 1:1 chat, and coded-message display.

## Features implemented (Phase 2)

- Email/password register + login
- Profile updates (username + profile image path)
- Friend requests by username
- Accept incoming requests
- 1:1 conversations with persisted message history
- Messages shown in app-specific coded text
- Decrypter tab (paste coded text -> English)
- Local backend API (Express) + local SQLite database (`sql.js`)

## Tech stack

- Desktop: Electron
- API: Express
- Database: SQLite via `sql.js`
- Auth: JWT + bcryptjs

## Run

1. Open PowerShell in:

```powershell
cd "path\to\coded-messages-app"
```

2. Start app:

```powershell
powershell -ExecutionPolicy Bypass -File ".\start-app.ps1"
```

## Standalone backend mode

This project can now run the API separately from the desktop app.

Start the backend by itself:

```powershell
npm run server:start
```

Useful environment variables:

- `CODED_MESSAGES_HOST`: bind host for the API server. Default: `0.0.0.0`
- `PORT` or `CODED_MESSAGES_PORT`: API port. Default: `3847`
- `CODED_MESSAGES_DB_PATH`: database file path
- `DATABASE_URL`: Postgres connection string for hosted databases such as Supabase
- `CODED_MESSAGES_API_BASE`: API URL the Electron app should use

Example: run the app against an external server instead of the embedded local API:

```powershell
$env:CODED_MESSAGES_API_BASE="https://your-server-url"
npm start
```

## Test workflow

1. Create account A.
2. Log out and create account B.
3. From B, send friend request to A's username.
4. Log back into A and accept request in `Requests`.
5. Open the friend in `Friends` and send messages.
6. Messages appear coded in chat view.
7. Use `Decrypter` tab to decode pasted coded text.

## Project structure

- `main.js`: Electron main process + API server startup
- `preload.js`: Secure renderer bridge (`codedApi`, `codedMessages`)
- `server/index.js`: Express + SQLite API implementation
- `renderer/index.html`: UI markup
- `renderer/styles.css`: UI styles
- `renderer/app.js`: Frontend logic
- `shared/codec.js`: Obfuscation encode/decode logic
- `data/app.sqlite`: Local app database (created at runtime)
