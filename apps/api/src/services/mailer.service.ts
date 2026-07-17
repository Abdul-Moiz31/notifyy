import nodemailer, { type Transporter } from "nodemailer";
import type { Bindings } from "../types.js";

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

/**
 * Reads SMTP config from Worker bindings (env), not process.env — env is only available
 * inside a request/scheduled handler in Workers, so this can't be resolved at module load
 * time the way apps/worker's Node process used to.
 */
export function smtpConfigFromEnv(env: Bindings): SmtpConfig {
  if (!env.SMTP_HOST || !env.SMTP_PORT) {
    throw new Error("SMTP_HOST and SMTP_PORT must be set");
  }

  return {
    host: env.SMTP_HOST,
    port: Number(env.SMTP_PORT),
    secure: env.SMTP_SECURE === "true",
    ...(env.SMTP_USER && env.SMTP_PASS ? { auth: { user: env.SMTP_USER, pass: env.SMTP_PASS } } : {}),
  };
}

/**
 * Nodemailer's SMTP transport uses Node's net/tls sockets — available in Workers via the
 * `nodejs_compat` compatibility flag (wrangler.toml), which backs `node:net`/`node:tls` with
 * the Workers TCP Sockets API. No provider switch needed (see ADR-005): same SMTP transport,
 * same provider-agnostic setup, just running on a different runtime.
 */
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
