import nodemailer, { type Transporter } from "nodemailer";

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  auth?: { user: string; pass: string };
}

export interface SendEmailInput {
  to: string;
  subject: string;
  body: string;
}

export interface SendEmailResult {
  providerMessageId: string;
}

export function smtpConfigFromEnv(): SmtpConfig {
  const host = process.env["SMTP_HOST"];
  const port = process.env["SMTP_PORT"];

  if (!host || !port) {
    throw new Error("SMTP_HOST and SMTP_PORT must be set");
  }

  const user = process.env["SMTP_USER"];
  const pass = process.env["SMTP_PASS"];

  return {
    host,
    port: Number(port),
    secure: process.env["SMTP_SECURE"] === "true",
    ...(user && pass ? { auth: { user, pass } } : {}),
  };
}

export function createTransporter(config: SmtpConfig): Transporter {
  return nodemailer.createTransport(config);
}

export async function sendEmail(
  transporter: Transporter,
  fromAddress: string,
  input: SendEmailInput,
): Promise<SendEmailResult> {
  const info = await transporter.sendMail({
    from: fromAddress,
    to: input.to,
    subject: input.subject,
    text: input.body,
  });

  return { providerMessageId: info.messageId };
}
