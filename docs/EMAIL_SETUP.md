# Email Setup

`Coded Messages` supports provider-based email delivery for:

- welcome email on signup
- password reset code email

The hosted backend does **not** use direct SMTP from Render free services. Render blocks outbound SMTP on the common mail ports, so email must go through an HTTP-accessible provider.

## Supported Providers

### 1. Google Apps Script webhook

Recommended when you control a working Google account for the sender address and want a lightweight setup.

Required Render variables:

- `GOOGLE_MAIL_WEBHOOK_URL`
- `GOOGLE_MAIL_WEBHOOK_SECRET`

Setup guide:

- [GOOGLE_MAIL_WEBHOOK.md](./GOOGLE_MAIL_WEBHOOK.md)

### 2. Brevo API

Supported as an alternate provider, but Brevo may require additional account/business verification before allowing transactional email sending.

Required Render variables:

- `BREVO_API_KEY`
- `BREVO_FROM`

## Provider Priority

The backend checks providers in this order:

1. Google Apps Script webhook
2. Brevo API
3. disabled mailer

So if both Google webhook and Brevo are configured, the Google webhook will be used.

## Health Check

The backend health endpoint reports the mail state:

- `mailer: "google-script"`
- `mailer: "brevo"`
- `mailer: "disabled"`

And:

- `mailConfigured: true`
- `mailConfigured: false`

Example:

```json
{
  "ok": true,
  "database": "postgres",
  "mailer": "google-script",
  "mailConfigured": true
}
```

## Production Recommendation

For a future release that restores account-email features, use a stable sender account or domain-backed mail provider and fully retest welcome-email and password-reset delivery in the hosted environment before turning those flows back on in the app UI.
