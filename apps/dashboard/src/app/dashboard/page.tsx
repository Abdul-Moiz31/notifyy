"use client";

import { useCallback, useEffect, useState } from "react";
import { useSession } from "@/lib/use-session";
import { ApiError, getMe, regenerateApiKey, signup, type MeResponse } from "@/lib/api-client";

export default function DashboardOverviewPage() {
  const session = useSession();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [revealedKey, setRevealedKey] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    const justIssued = sessionStorage.getItem("notifyEngine:justIssuedApiKey");
    if (justIssued) sessionStorage.removeItem("notifyEngine:justIssuedApiKey");
    return justIssued;
  });
  const [showRevealInfo, setShowRevealInfo] = useState(false);
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [regenerating, setRegenerating] = useState(false);

  const load = useCallback(async (accessToken: string) => {
    try {
      const meResponse = await getMe(accessToken);
      setMe(meResponse);
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        const signupResult = await signup(accessToken);
        if (signupResult.apiKey) {
          setRevealedKey(signupResult.apiKey);
        }
        setMe(await getMe(accessToken));
        setError(null);
      } else {
        setError(err instanceof Error ? err.message : "Failed to load account");
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!session) return;
    // load's setState calls all happen after its internal await; safe despite the lint rule's static check.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load(session.access_token);
  }, [session, load]);

  async function handleRegenerate() {
    if (!session) return;
    if (!window.confirm("This invalidates your current API key immediately. Continue?")) return;

    setRegenerating(true);
    setError(null);

    try {
      const result = await regenerateApiKey(session.access_token);
      setRevealedKey(result.apiKey);
      setShowRevealInfo(false);
      setMe(await getMe(session.access_token));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to regenerate key");
    } finally {
      setRegenerating(false);
    }
  }

  async function handleCopy(value: string) {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  if (loading) {
    return <p className="muted">Loading…</p>;
  }

  return (
    <>
      <h1>Overview</h1>
      {me && <p className="lede">{me.tenant.name}</p>}

      {error && <div className="form-error">{error}</div>}

      {revealedKey && (
        <div className="key-banner">
          <strong>Your API key — copy it now, it won&apos;t be shown again.</strong>
          <div className="key-row" style={{ marginTop: "0.6rem" }}>
            <code className="key-value">{revealedKey}</code>
            <button className="btn" onClick={() => handleCopy(revealedKey)}>
              {copied ? "Copied" : "Copy"}
            </button>
            <button className="btn" onClick={() => setRevealedKey(null)}>
              I&apos;ve saved it
            </button>
          </div>
        </div>
      )}

      <section className="section card">
        <h2>API key</h2>
        {me?.apiKey ? (
          <>
            <div className="key-row">
              <code className="key-value">{me.apiKey.masked}</code>
              <button className="btn" onClick={() => setShowRevealInfo((v) => !v)}>
                Reveal
              </button>
              <button className="btn" onClick={handleRegenerate} disabled={regenerating}>
                {regenerating ? "Regenerating…" : "Regenerate"}
              </button>
            </div>
            {showRevealInfo && (
              <p className="muted" style={{ marginTop: "0.6rem" }}>
                The full key is only ever shown once, right when it&apos;s created or regenerated
                — we only store a hash of it, so it can&apos;t be displayed again. Use
                &quot;Regenerate&quot; if you&apos;ve lost it (this invalidates the old one).
              </p>
            )}
            <p className="muted" style={{ marginTop: "0.6rem" }}>
              Created {new Date(me.apiKey.createdAt).toLocaleString()} · Last used{" "}
              {me.apiKey.lastUsedAt ? new Date(me.apiKey.lastUsedAt).toLocaleString() : "never"}
            </p>
          </>
        ) : (
          <p className="muted">No active API key.</p>
        )}
      </section>
    </>
  );
}
