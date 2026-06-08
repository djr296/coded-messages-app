# V1 Test Checklist

Use this checklist before cutting `v1.0.0`.

Status values:

- `PASS`
- `FAIL`
- `BLOCKED`
- `NOT TESTED`

Current known blocker:

- Email sender account / provider is not fully settled yet, so email-dependent tests are blocked until a stable sender path is working again.

## Account Tests

- [ ] `NOT TESTED` Create a new account
- [ ] `NOT TESTED` Log out
- [ ] `NOT TESTED` Log back in
- [ ] `NOT TESTED` Wrong password shows a clean error
- [ ] `BLOCKED` Password reset email arrives
- [ ] `BLOCKED` Password reset changes the password

## Friend Tests

- [ ] `NOT TESTED` Send friend request
- [ ] `NOT TESTED` Accept friend request
- [ ] `NOT TESTED` Decline friend request
- [ ] `NOT TESTED` Cancel outgoing request
- [ ] `NOT TESTED` Remove friend

## Chat Tests

- [ ] `NOT TESTED` Send encoded message
- [ ] `NOT TESTED` Send plain text message
- [ ] `NOT TESTED` Timestamps appear
- [ ] `NOT TESTED` Messages appear on both devices

## Install Tests

- [ ] `NOT TESTED` Download from GitHub Release
- [ ] `NOT TESTED` Install on Windows
- [ ] `NOT TESTED` Launch without PowerShell
- [ ] `NOT TESTED` Log in successfully

## Failure Tests

- [ ] `NOT TESTED` Server wake-up message appears if Render is asleep
- [ ] `NOT TESTED` App does not crash when internet is slow
- [ ] `NOT TESTED` Duplicate email gives a clear message
- [ ] `NOT TESTED` Duplicate username gives a clear message

## Release Gate

Do not ship `v1.0.0` publicly until:

- all non-email critical tests are `PASS`
- blocked email tests are resolved and retested
- README matches the current release
- installer build succeeds for the release version
- final privacy/security sanity check is complete
