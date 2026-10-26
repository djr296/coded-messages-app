# Coded Messages 2.5.0 - Security Update

Update all devices to 2.5.0. Older versions are incompatible with the strengthened Firebase rules and may show permission errors. Existing accounts, friends, and conversations are preserved.

- Fixed unauthorized conversation-access and group-membership vulnerabilities.
- Moved account emails out of public profiles into owner-only records.
- Added atomic username reservations and database-enforced write limits.
- Updated Electron and dependencies; enabled the renderer sandbox.
- Protected saved sessions with Windows encryption.
- Hardened attachments, navigation, popups, and application permissions.
- Restored compatible group creation and secure 24-hour/permanent invites. Regenerate old invite links.
- New passwords require 12 characters; existing passwords still work.
- Removed misleading remote-logout controls. Local logout remains available.
- Enabled ongoing dependency, secret, and security regression checks.

Validation: 22 automated tests passed, the packaged app passed its security smoke test, and a live Firebase test passed registration, login, friends, messages, groups, invites, and private-email checks. npm audit reported zero known vulnerabilities at build time.

Download and run Coded-Messages-Setup-2.5.0.exe with the app closed. You do not need Node.js, PowerShell, Render, or Supabase.

The installer is unsigned. Encoded display is not end-to-end encryption. Password-reset and remote-session-revocation features are not included in this release.
