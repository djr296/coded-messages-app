# Firebase Migration

This project is migrating from the current Render + Supabase backend to Firebase in phases.

## Current Firebase Project

- Firebase project ID: `coded-messages`
- Firestore location: `nam5`
- Firebase Auth provider enabled: Email/Password
- Firestore rules start locked down by default

## Migration Strategy

Do not delete Render or Supabase until the Firebase version has passed full two-device testing.

1. Add Firebase project files and client config. Done.
2. Move account creation and login to Firebase Auth. Done for new logins/registers, with a temporary Render session bridge still used during sign-in.
3. Add Firestore collections and security rules. Done for the migrated social/chat collections.
4. Move profile and presence data. Done: profiles are mirrored to Firestore after Firebase login/register and profile saves.
5. Move friend requests, friendships, blocks, and reports. Done for new Firebase-backed app sessions.
6. Move direct messages. Done for new Firebase-backed app sessions.
7. Move group chats and invite links. Done for new Firebase-backed app sessions.
8. Test installed Windows builds on two devices.
9. Retire Render and Supabase only after Firebase is stable.

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

The migration is not ready for Render/Supabase removal yet. The desktop app still uses the hosted Render API as a compatibility bridge when exchanging Firebase ID tokens for the existing app session model. Existing Supabase data is not automatically migrated into Firestore.
