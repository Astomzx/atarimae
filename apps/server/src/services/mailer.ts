import type { SecretStore } from "@atarimae/secret-store";
import nodemailer, { type Transporter } from "nodemailer";

import type { Database } from "../db.js";

/**
 * Outbound email.
 *
 * Atarimae does not run a mail server. It connects to one the administrator
 * already has, which is the difference between "we do not do email" and "we do
 * not operate an MTA".
 *
 * v1.0 sends exactly three kinds of message, all tied to an acknowledgement
 * obligation. No per-message chat mail, no digests, no marketing.
 */

export const SMTP_SETTINGS_KEY = "smtp";

export interface SmtpSettings {
  host: string;
  port: number;
  secure: boolean;
  username: string | null;
  /** Ciphertext. Never leaves the server in plaintext. */
  passwordCiphertext: string | null;
  fromAddress: string;
  fromName: string;
}

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  configured: boolean;
  send(message: MailMessage): Promise<void>;
}

/** Reads SMTP configuration, or null when an administrator has not set it up. */
export async function loadSmtpSettings(db: Database): Promise<SmtpSettings | null> {
  const { rows } = await db.query<{ value: SmtpSettings }>(
    "SELECT value FROM system_settings WHERE key = $1",
    [SMTP_SETTINGS_KEY],
  );
  return rows[0]?.value ?? null;
}

/**
 * A mailer that refuses rather than pretending.
 *
 * When SMTP is unconfigured, sending throws. The outbox worker records that as
 * a delivery failure and retries later — which is correct: the notification is
 * still owed, and an administrator configuring SMTP tomorrow should see it go
 * out. Silently dropping the message would be the familiar failure of a system
 * that reports success while doing nothing.
 */
export function createMailer(
  settings: SmtpSettings | null,
  secrets: SecretStore,
): Mailer {
  if (!settings) {
    return {
      configured: false,
      send() {
        return Promise.reject(
          new Error("SMTP is not configured. An administrator must set it up first."),
        );
      },
    };
  }

  let transporter: Transporter | null = null;

  const connect = async (): Promise<Transporter> => {
    if (transporter) return transporter;

    const password = settings.passwordCiphertext
      ? await secrets.decrypt(settings.passwordCiphertext)
      : null;

    transporter = nodemailer.createTransport({
      host: settings.host,
      port: settings.port,
      secure: settings.secure,
      ...(settings.username && password
        ? { auth: { user: settings.username, pass: password } }
        : {}),
      // A hung SMTP connection must not hold a worker slot indefinitely.
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });

    return transporter;
  };

  return {
    configured: true,
    async send(message) {
      const smtp = await connect();
      await smtp.sendMail({
        from: `${settings.fromName} <${settings.fromAddress}>`,
        to: message.to,
        subject: message.subject,
        text: message.text,
      });
    },
  };
}

/** Verifies a configuration by connecting, without sending anything. */
export async function verifySmtp(
  settings: SmtpSettings,
  secrets: SecretStore,
): Promise<void> {
  const password = settings.passwordCiphertext
    ? await secrets.decrypt(settings.passwordCiphertext)
    : null;

  const transporter = nodemailer.createTransport({
    host: settings.host,
    port: settings.port,
    secure: settings.secure,
    ...(settings.username && password
      ? { auth: { user: settings.username, pass: password } }
      : {}),
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
  });

  try {
    await transporter.verify();
  } finally {
    transporter.close();
  }
}
