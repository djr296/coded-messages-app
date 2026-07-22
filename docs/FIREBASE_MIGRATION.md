# Firebase Migration

This project has moved the desktop app from the Render + Supabase backend to Firebase for the active app data path.

## Current Firebase Project

- Firebase project ID: `coded-messages`
- Firestore location: `nam5`
- Firebase Auth provider enabled: Email/Password
- Firestore rules are deployed for the app collections

## Migration Status

The desktop app no longer uses Render or Supabase for login/register, profile data, friends, blocks, reports, conversations, messages, or group invite links.

1. Add Firebase project files and client config. Done.
2. Move account creation and login to Firebase Auth. Done.
3. Add Firestore collections and security rules. Done for the migrated social/chat collections.
4. Move profile and presence data. Done: profiles are mirrored to Firestore after Firebase login/register and profile saves.
5. Move friend requests, friendships, blocks, and reports. Done for new Firebase-backed app sessions.
6. Move direct messages. Done for new Firebase-backed app sessions.
7. Move group chats and invite links. Done for new Firebase-backed app sessions.
8. Test installed Windows builds on two devices.
9. Retire Render and Supabase operationally after installed Firebase builds pass testing.

## Target Firestore Collections

- `users`
- `friendRequests`
- `friendships`
- `conversations`
- `messages`
- `groupInvites`
- `blocks`
- `reports`

## Notes

The Firebase web config in `shared/firebase-config.js` is public client configuration. It is not a private key.

Never commit Firebase service account JSON files, private keys, or admin credentials.

Existing Supabase data is not automatically migrated into Firestore. Accounts and chats for the Firebase release should be created/tested in Firebase.
