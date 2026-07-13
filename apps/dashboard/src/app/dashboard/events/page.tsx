"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import { useSession } from "@/lib/use-session";
import { getEvent, listEvents, type Delivery, type EventDetail, type NotificationEvent } from "@/lib/api-client";

const PAGE_SIZE = 20;

function StatusBadge({ status }: { status: string }) {
  return <span className={`badge badge-${status}`}>{status}</span>;
}

function DeliveryRow({ delivery }: { delivery: Delivery }) {
  return (
    <div className="card" style={{ marginBottom: "0.6rem" }}>
      <div className="spread">
        <span>
          <strong>{delivery.channel}</strong> · attempt {delivery.attemptCount}
        </span>
        <StatusBadge status={delivery.status} />
      </div>
      <p className="muted" style={{ marginTop: "0.4rem" }}>
        {delivery.lastAttemptedAt
          ? `Last attempted ${new Date(delivery.lastAttemptedAt).toLocaleString()}`
          : "Not yet attempted"}
        {delivery.providerMessageId && ` · message id ${delivery.providerMessageId}`}
      </p>
      {delivery.errorMessage && <p className="error-text" style={{ marginTop: "0.4rem" }}>{delivery.errorMessage}</p>}
    </div>
  );
}

export default function EventsPage() {
  const session = useSession();
  const [events, setEvents] = useState<NotificationEvent[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, EventDetail>>({});
  const [detailError, setDetailError] = useState<string | null>(null);

  const load = useCallback(
    async (accessToken: string, newOffset: number) => {
      try {
        const result = await listEvents(accessToken, { limit: PAGE_SIZE, offset: newOffset });
        setEvents(result.events);
        setTotal(result.total);
        setOffset(newOffset);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load events");
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    if (!session) return;
    // load's setState calls all happen after its internal await; safe despite the lint rule's static check.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load(session.access_token, 0);
  }, [session, load]);

  async function toggleRow(eventId: string) {
    if (expandedId === eventId) {
      setExpandedId(null);
      return;
    }

    setExpandedId(eventId);
    setDetailError(null);

    if (!details[eventId] && session) {
      try {
        const detail = await getEvent(session.access_token, eventId);
        setDetails((prev) => ({ ...prev, [eventId]: detail }));
      } catch (err) {
        setDetailError(err instanceof Error ? err.message : "Failed to load delivery attempts");
      }
    }
  }

  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <>
      <h1>Events</h1>
      <p className="lede">Every notification event triggered on your API key.</p>

      {error && <div className="form-error">{error}</div>}

      {!loading && events.length === 0 && !error && (
        <p className="muted">
          No events yet. Trigger one with <code>POST /v1/events</code> using your API key.
        </p>
      )}

      {events.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Event type</th>
                <th>Status</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {events.map((event) => (
                <Fragment key={event.id}>
                  <tr
                    className={`row-clickable ${expandedId === event.id ? "row-expanded" : ""}`}
                    onClick={() => toggleRow(event.id)}
                  >
                    <td className="mono">{event.eventType}</td>
                    <td>
                      <StatusBadge status={event.status} />
                    </td>
                    <td className="muted">{new Date(event.createdAt).toLocaleString()}</td>
                  </tr>
                  {expandedId === event.id && (
                    <tr>
                      <td colSpan={3} style={{ padding: 0 }}>
                        <div className="detail-panel">
                          <div className="detail-grid">
                            <div>
                              <div className="detail-label">Event ID</div>
                              <div className="mono">{event.id}</div>
                            </div>
                            <div>
                              <div className="detail-label">Idempotency key</div>
                              <div className="mono">{event.idempotencyKey}</div>
                            </div>
                          </div>
                          {detailError && <div className="form-error">{detailError}</div>}
                          {!details[event.id] && !detailError && (
                            <p className="muted">Loading delivery attempts…</p>
                          )}
                          {details[event.id] && details[event.id].deliveries.length === 0 && (
                            <p className="muted">No delivery attempts yet.</p>
                          )}
                          {details[event.id]?.deliveries.map((delivery) => (
                            <DeliveryRow key={delivery.id} delivery={delivery} />
                          ))}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {total > PAGE_SIZE && session && (
        <div className="pagination">
          <span>
            Page {page} of {pageCount} · {total} events
          </span>
          <div className="row">
            <button
              className="btn"
              disabled={offset === 0}
              onClick={() => load(session.access_token, Math.max(0, offset - PAGE_SIZE))}
            >
              Previous
            </button>
            <button
              className="btn"
              disabled={offset + PAGE_SIZE >= total}
              onClick={() => load(session.access_token, offset + PAGE_SIZE)}
            >
              Next
            </button>
          </div>
        </div>
      )}
    </>
  );
}
