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
      }
    };
  }

  const transport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
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
    }
  };
}

module.exports = {
  createMailer
};
