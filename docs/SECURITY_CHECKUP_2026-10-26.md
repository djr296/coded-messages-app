# Security update completed: October 26, 2026

Version 2.5.0 addresses the security problems identified in the checkup. The production Firebase rules, account settings, and profile migration have been applied and independently verified. Installed copies must update to receive the desktop protections and use the new write protocol.

## Findings and fixes

| Original finding | Fix | Verification |
| --- | --- | --- |
| Critical: forged sidebar entries granted message access | Only canonical conversation membership grants access. Sidebar copies cannot authorize a read or send. | Emulator attack tests and deployed-rule comparison. |
| Critical: outsiders could add themselves to groups | Membership changes require the owner, a self-leave operation, or a valid invitation proved in the same write. Expiry and revocation are enforced by Firebase before joining. | Negative tests for forged/expired/revoked joins; real live invite, revoke, and leave test. |
| High: public profiles included account emails | Emails moved into owner-only privateUsers records. Public users records no longer contain email fields, public profile listing is disabled, and writes cannot reintroduce email fields. | All 18 production profiles migrated; independent read-back found zero public email fields. Live test confirmed another account receives HTTP 403 for a private email record. |
| High: forged friendship/request records | Request identities and role-specific transitions are enforced. Friendship creation needs acceptance. Mirrors must match canonical records. | Request impersonation, self-acceptance, blocked-request, and normal friendship tests. |
| High: obsolete Electron runtime | Updated Electron 37.10.3 to 45.0.0 and refreshed dependencies. Legacy HTTP server code and dependencies are excluded from desktop packaging. | Actual packaged app launched in an isolated test profile. |
| High: unvalidated attachments and navigation | Strict bounded data-URL formats, CSP, denied popups/navigation/webviews/permissions, and trusted-frame IPC checks. | Content tests and packaged renderer smoke test. |
| Medium: unencrypted saved refresh tokens | Sessions use Windows-protected Electron safeStorage. Legacy localStorage session keys are removed during migration. No plaintext persistence fallback. | Persistence tests and packaged bridge smoke test. Existing cached disk bytes are not guaranteed to be forensically erased. |
| Medium: disabled renderer sandbox | Bundled the preload, replaced Node-only token/random helpers with Web APIs, and enabled sandboxing. | Packaged preload ran with sandbox=true, no renderer Node access, working Web Crypto/encoding, and blocked eval/popups. |
| Medium: username check/write race | Username reservations, public profile writes, private account writes, and old reservation release use atomic commits and write preconditions. | Concurrent rename test allows exactly one claimant; registration/login and migration tests passed. |
| Medium: no application write quota | Firebase validates minute/day counters in the same atomic write as messages, requests, reports, profiles, groups, and invites. Counter resets and unmetered message writes are denied. | Direct-write bypass/reset tests and live app operations. |
| Medium: remote logout reported false success | Removed the unsupported controls from the visible UI; API calls explicitly report that remote revocation is unavailable. | No claim of remote revocation remains in the README. Local logout remains available. |

## Production migration

The profile inspection found 18 records containing public email fields and no username conflicts. An encrypted backup was created and its decryption verified before changes were applied. A preconditioned 54-write migration preserved existing accounts and public profile names, created private account records and username reservations, and removed all 18 public email fields.

The backup remains under ignored data/ storage and is protected using Windows encryption. It is not included in Git or release assets. Messages, conversations, and friendships were not changed by the profile migration.

The live rules were fetched after deployment and matched the reviewed local file exactly. Firebase also now enforces at least 12 characters for newly set passwords, with existing-password upgrades on sign-in disabled. Existing account passwords continue to work. Email-enumeration protection was verified enabled.

## Validation

- 22 automated tests passed across legacy API regressions, content validation, session persistence/encoding, privacy migration, Firestore authorization, quotas, concurrent username reservation, and actual preload client operations.
- The original rule weaknesses were reproduced only in the local emulator.
- A live smoke test passed registration, login, friendship, plain/encoded message handling, group creation/joining, revocation, leaving, and private-email denial using three temporary accounts.
- All three temporary accounts and 37 temporary Firestore records were removed after that test. Cleanup reported zero failures. A further inspection confirmed production still had 18 profiles and zero public email fields.
- The packaged app archive passed the hidden Electron smoke test with an isolated profile. The existing installed user profile was not opened.
- The original npm audit found 22 vulnerable packages (1 critical, 19 high, 2 moderate). The updated lockfile has zero known npm vulnerabilities as checked on October 26, 2026. This is not a guarantee about undisclosed vulnerabilities or supply-chain attacks.
- Common private-key, GitHub-token, Brevo-key, and service-account-key patterns were checked across 41 reachable Git commits without matches. This is a pattern scan, not proof that no secret has ever existed in every external service, unreachable commit, or historical release.
- No PHP code or runtime dependency was found in the tracked application.

## Operational protections

GitHub vulnerability alerts, automated dependency security-fix pull requests, secret scanning, and secret push protection are enabled. Weekly dependency checks and CI tests/audits are included. CI runs the Firestore rules suite against a loopback-only emulator using a pinned emulator checksum and commit-pinned actions.

GitHub's security workflow passed for the coordinated update and the default branch now reports zero open Dependabot vulnerability alerts. The Google API key alert refers to the intentionally public Firebase client configuration, not a private service-account credential. Its API allowlist was narrowed to Identity Toolkit and Secure Token, and both authentication endpoints were checked after applying the restrictions. Firebase rules, not secrecy of this client key, enforce database authorization. See [Firebase's API key guidance](https://firebase.google.com/docs/projects/api-keys).

Use Node 24 LTS for development. The system-wide Node 20 installation was not replaced; the coordinated build and checks used the available supported Node 24 runtime. The development launcher refuses an unsupported runtime.

Primary per-account write limits are:

| Category | Per minute | Per day |
| --- | ---: | ---: |
| Messages | 60 | 1000 |
| Friend-request operations | 20 | 200 |
| Reports | 5 | 20 |
| Profile edits | 5 | 30 |
| New conversations | 5 | 20 |
| New invite links | 5 | 20 |

Read traffic and all possible administrative actions cannot be given a universal monetary cap solely through these client/database rules. Monitor Firebase usage and billing if paid billing is enabled. The write limits do not promise immunity to distributed abuse using many accounts.

## Compatibility and remaining boundaries

Version 2.5.0 is required for the new profile and write protocols. Old clients will encounter permission errors rather than bypassing the security checks. Existing group links predating server-enforced expiry should be regenerated by their creators. Existing accounts, friends, and conversations are retained.

The installer is unsigned because no publisher code-signing certificate is configured. A trusted publisher certificate requires the owner's signing setup; generating an untrusted self-signed certificate would not solve publisher verification. SHA-256 checksums establish matching bytes only when the expected checksum comes from a trusted source.

Encoded mode is a reversible display substitution, not end-to-end encryption. Message bodies remain readable to an authorized service operator. No guarantee is made that the service has never been compromised: the checkup found no evidence of exploitation, but it was not a forensic investigation, and historical memberships created under old rules cannot be retrospectively authenticated from source code alone.

Remote device-session revocation remains outside this client-only release. Its previously misleading controls are hidden and it is not advertised as implemented.

## Reproducing checks

Use npm test for local API/content/session/migration checks, and npm run test:rules for Firestore authorization and actual client integration tests. The latter requires Java 21 and a cached emulator JAR or FIRESTORE_EMULATOR_JAR. It uses the demo-coded-messages project on loopback and never production user data.

The desktop smoke test runs scripts/security-desktop-smoke.cjs using the Electron development executable. CODED_MESSAGES_SMOKE_ROOT may point to the packaged app.asar to verify the built artifact with an isolated profile.

## Official references

- [Electron security guidance](https://www.electronjs.org/docs/latest/tutorial/security)
- [Electron process sandboxing](https://www.electronjs.org/docs/latest/tutorial/sandbox)
- [Node.js support status](https://nodejs.org/en/about/previous-releases)
- [Firebase authorization conditions](https://firebase.google.com/docs/firestore/security/rules-conditions)
- [Firebase atomic writes](https://firebase.google.com/docs/firestore/manage-data/transactions)
