import { randomBytes, createHash } from "node:crypto";
import { API_KEY_PREFIX } from "./constants.js";

export function generateApiKey(): string {
  return `${API_KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
}

export function hashApiKey(rawKey: string): string {
  return createHash("sha256").update(rawKey).digest("hex");
}
