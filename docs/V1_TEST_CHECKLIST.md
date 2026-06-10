# V1 Test Checklist

Use this checklist before cutting `v1.0.0`.

Status values:

- `PASS`
- `FAIL`
- `NOT TESTED`
- `DEFERRED`

## Account Tests

- [x] `PASS` Create a new account
- [x] `PASS` Log out
- [x] `PASS` Log back in
- [x] `PASS` Wrong password shows a clean error
- [ ] `DEFERRED` Password reset email arrives
- [ ] `DEFERRED` Password reset changes the password

## Friend Tests

- [x] `PASS` Send friend request
- [x] `PASS` Accept friend request
- [x] `PASS` Decline friend request
- [x] `PASS` Cancel outgoing request
- [x] `PASS` Remove friend

## Chat Tests

- [x] `PASS` Send encoded message
- [x] `PASS` Send plain text message
- [x] `PASS` Timestamps appear
- [x] `PASS` Messages appear on both devices

## Install Tests

- [x] `PASS` Download from GitHub Release
- [x] `PASS` Install on Windows
- [x] `PASS` Launch without PowerShell
- [x] `PASS` Log in successfully

## Failure Tests

- [x] `PASS` Server wake-up message appears if Render is asleep
- [x] `PASS` App does not crash when internet is slow
- [x] `PASS` Duplicate email gives a clear message
- [x] `PASS` Duplicate username gives a clear message

## Post-v1 Feature Regression

- [ ] `NOT TESTED` Profile picture appears after signing in on a second device
- [ ] `NOT TESTED` Online and last-seen presence updates
- [ ] `NOT TESTED` Image attachment sends and appears on both devices
- [ ] `NOT TESTED` PDF or text attachment downloads successfully
- [ ] `NOT TESTED` Blocking removes the relationship and prevents new requests/messages
- [ ] `NOT TESTED` Reporting submits successfully
- [ ] `NOT TESTED` Active sessions appear and another session can be revoked
- [ ] `NOT TESTED` Revoked session must sign in again
- [ ] `NOT TESTED` Oversized or unsupported attachments show a clear error

## Release Gate

Do not ship `v1.0.0` publicly until:

- all in-scope `v1.0.0` tests are `PASS`
- deferred email features are clearly excluded from the release notes and README
- README matches the current release
- installer build succeeds for the release version
- final privacy/security sanity check is complete
