const API_URL = process.env["NEXT_PUBLIC_API_URL"];

if (!API_URL) {
  throw new Error("NEXT_PUBLIC_API_URL is required");
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, accessToken: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      ...init?.headers,
      authorization: `Bearer ${accessToken}`,
      ...(init?.body ? { "content-type": "application/json" } : {}),
    },
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new ApiError(response.status, (body as { error?: string }).error ?? response.statusText);
  }

  return response.json() as Promise<T>;
}

export interface Tenant {
  id: string;
  name: string;
}

export interface ApiKeyMeta {
  masked: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface MeResponse {
  tenant: Tenant;
  apiKey: ApiKeyMeta | null;
}

export interface SignupResponse {
  tenant: Tenant;
  apiKey: string | null;
}

export interface NotificationEvent {
  id: string;
  tenantId: string;
  idempotencyKey: string;
  eventType: string;
  payload: Record<string, unknown>;
  status: "pending" | "processing" | "sent" | "failed" | "dead_letter";
  createdAt: string;
  updatedAt: string;
}

export interface Delivery {
  id: string;
  eventId: string;
  tenantId: string;
  channel: "email";
  providerMessageId: string | null;
  status: "pending" | "sent" | "failed";
  attemptCount: number;
  lastAttemptedAt: string | null;
  errorMessage: string | null;
}

export interface EventDetail extends NotificationEvent {
  deliveries: Delivery[];
}

export interface ListEventsResponse {
  events: NotificationEvent[];
  total: number;
  limit: number;
  offset: number;
}

export function signup(accessToken: string, name?: string) {
  return request<SignupResponse>("/v1/dashboard/signup", accessToken, {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}

export function getMe(accessToken: string) {
  return request<MeResponse>("/v1/dashboard/me", accessToken);
}

export function regenerateApiKey(accessToken: string) {
  return request<{ apiKey: string }>("/v1/dashboard/api-key/regenerate", accessToken, {
    method: "POST",
  });
}

export function listEvents(accessToken: string, params: { limit: number; offset: number }) {
  const query = new URLSearchParams({
    limit: String(params.limit),
    offset: String(params.offset),
  });
  return request<ListEventsResponse>(`/v1/dashboard/events?${query.toString()}`, accessToken);
}

export function getEvent(accessToken: string, id: string) {
  return request<EventDetail>(`/v1/dashboard/events/${id}`, accessToken);
}
