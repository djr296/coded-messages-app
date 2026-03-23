const nodemailer = require("nodemailer");

function getMailerConfig() {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const from = process.env.SMTP_FROM;

  if (!host || !port || !user || !pass || !from) {
    return null;
  }

  return {
    host,
    port,
    user,
    pass,
    from,
    secure: port === 465
  };
}

function createMailer() {
  const config = getMailerConfig();

  if (!config) {
    return {
      enabled: false,
      async sendWelcomeEmail() {
        return false;
      },
      async sendPasswordResetEmail() {
        return false;
      }
    };
  }

  const transport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    requireTLS: !config.secure,
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 20000,
    auth: {
      user: config.user,
      pass: config.pass
    }
  });

  return {
    enabled: true,
    async sendWelcomeEmail({ email, username }) {
      await transport.sendMail({
        from: config.from,
        to: email,
        subject: "Welcome to Coded Messages",
        text: `Welcome to Coded Messages.\n\nYour account has been created successfully.\n\nUsername: ${username}\n\nYou can now sign in and start messaging.`,
        html: [
          "<h2>Welcome to Coded Messages</h2>",
          "<p>Your account has been created successfully.</p>",
          `<p><strong>Username:</strong> ${username}</p>`,
          "<p>You can now sign in and start messaging.</p>"
        ].join("")
      });

      return true;
    },
    async sendPasswordResetEmail({ email, username, code }) {
      await transport.sendMail({
        from: config.from,
        to: email,
        subject: "Coded Messages password reset code",
        text: [
          "We received a request to reset your Coded Messages password.",
          "",
          `Username: ${username}`,
          `Reset code: ${code}`,
          "",
          "Enter this code in the app to choose a new password.",
          "If you did not request this, you can ignore this email."
        ].join("\n"),
        html: [
          "<h2>Coded Messages password reset</h2>",
          "<p>We received a request to reset your password.</p>",
          `<p><strong>Username:</strong> ${username}</p>`,
          `<p><strong>Reset code:</strong> ${code}</p>`,
          "<p>Enter this code in the app to choose a new password.</p>",
          "<p>If you did not request this, you can ignore this email.</p>"
        ].join("")
      });

      return true;
    }
  };
}

module.exports = {
  createMailer
};
