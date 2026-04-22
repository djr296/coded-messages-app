# Google Mail Webhook

Use this when hosted SMTP or transactional email providers are blocked or require business verification.

Create a Google Apps Script while signed into a working sender Google account, paste this script, deploy it as a web app, and save the web app URL in Render as `GOOGLE_MAIL_WEBHOOK_URL`.

Set a long random value in both:

- Google Apps Script project property: `MAIL_WEBHOOK_SECRET`
- Render environment variable: `GOOGLE_MAIL_WEBHOOK_SECRET`

```javascript
function doPost(e) {
  try {
    const props = PropertiesService.getScriptProperties();
    const expectedSecret = props.getProperty('MAIL_WEBHOOK_SECRET');
    const body = JSON.parse(e.postData.contents || '{}');

    if (!expectedSecret || body.secret !== expectedSecret) {
      return jsonResponse({ ok: false, error: 'Unauthorized' }, 401);
    }

    if (!body.to || !body.subject || !body.text) {
      return jsonResponse({ ok: false, error: 'Missing required email fields' }, 400);
    }

    GmailApp.sendEmail(body.to, body.subject, body.text, {
      name: 'Coded Messages',
      htmlBody: body.html || body.text
    });

    return jsonResponse({ ok: true });
  } catch (err) {
    return jsonResponse({ ok: false, error: String(err && err.message ? err.message : err) }, 500);
  }
}

function jsonResponse(payload, statusCode) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}
```

Deploy settings:

- Type: Web app
- Execute as: Me
- Who has access: Anyone

The shared secret prevents random people from using the web app.
