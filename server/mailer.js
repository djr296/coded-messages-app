function parseFromAddress(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return null;
  }

  const match = raw.match(/^(.*)<([^>]+)>$/);
  if (!match) {
    return { name: "", email: raw };
  }

  return {
    name: match[1].trim().replace(/^"|"$/g, ""),
    email: match[2].trim()
  };
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildWelcomeContent({ username }) {
  const safeUsername = escapeHtml(username);

  return {
    subject: "Welcome to Coded Messages",
    text: `Welcome to Coded Messages, ${username}!\n\nYour account has been created successfully. You can now sign in and start chatting.`,
    html: `
      <div style="font-family:Segoe UI,Arial,sans-serif;line-height:1.6;color:#1b2430">
        <h2 style="margin-bottom:8px;">Welcome to Coded Messages</h2>
        <p>Your account for <strong>${safeUsername}</strong> has been created successfully.</p>
        <p>You can now sign in and start chatting.</p>
      </div>
    `
  };
}

function buildPasswordResetContent({ username, code }) {
  const safeUsername = escapeHtml(username);
  const safeCode = escapeHtml(code);

  return {
    subject: "Your Coded Messages password reset code",
    text: `Hi ${username},\n\nUse this reset code to change your password: ${code}\n\nThis code expires in 15 minutes.\nIf you did not request this, you can ignore this email.`,
    html: `
      <div style="font-family:Segoe UI,Arial,sans-serif;line-height:1.6;color:#1b2430">
        <h2 style="margin-bottom:8px;">Password reset</h2>
        <p>Hi <strong>${safeUsername}</strong>,</p>
        <p>Use this reset code to change your password:</p>
        <div style="font-size:30px;font-weight:700;letter-spacing:6px;margin:18px 0;color:#0a6c72;">${safeCode}</div>
        <p>This code expires in 15 minutes.</p>
        <p>If you did not request this, you can ignore this email.</p>
      </div>
    `
  };
}

async function sendBrevoEmail({ apiKey, from, to, subject, text, html }) {
  const response = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      accept: "application/json",
      "api-key": apiKey,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      sender: {
        name: from.name || undefined,
        email: from.email
      },
      to: [
        {
          email: to.email,
          name: to.name || undefined
        }
      ],
      subject,
      textContent: text,
      htmlContent: html
    })
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Brevo email request failed (${response.status}): ${body || "No response body"}`);
  }
}

function createDisabledMailer(reason) {
  return {
    enabled: false,
    provider: "disabled",
    reason,
    sendWelcomeEmail: async () => {},
    sendPasswordResetEmail: async () => {}
  };
}

function createBrevoMailer() {
  const apiKey = String(process.env.BREVO_API_KEY || "").trim();
  if (!apiKey) {
    return null;
  }

  const from = parseFromAddress(
    process.env.BREVO_SENDER
    || process.env.BREVO_FROM
    || process.env.SMTP_FROM
    || ""
  );

  if (!from || !from.email) {
    return createDisabledMailer("BREVO_API_KEY is set, but no valid sender address was configured.");
  }

  const send = async ({ email, username, content }) => {
    await sendBrevoEmail({
      apiKey,
      from,
      to: { email, name: username || "" },
      subject: content.subject,
      text: content.text,
      html: content.html
    });
  };

  return {
    enabled: true,
    provider: "brevo",
    reason: "",
    sendWelcomeEmail: async ({ email, username }) => {
      await send({
        email,
        username,
        content: buildWelcomeContent({ username })
      });
    },
    sendPasswordResetEmail: async ({ email, username, code }) => {
      await send({
        email,
        username,
        content: buildPasswordResetContent({ username, code })
      });
    }
  };
}

function createMailer() {
  const brevoMailer = createBrevoMailer();
  if (brevoMailer) {
    return brevoMailer;
  }

  return createDisabledMailer(
    "No supported email provider is configured. Render free services block Gmail SMTP on ports 465/587."
  );
}

module.exports = {
  createMailer
};
