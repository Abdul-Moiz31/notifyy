import Link from "next/link";

const CURL_EXAMPLE = `curl https://api.yourdomain.com/v1/events \\
  -H "Authorization: Bearer ntfy_your_api_key" \\
  -H "Content-Type: application/json" \\
  -d '{
    "idempotency_key": "welcome-email-user-42",
    "event_type": "user.signup",
    "payload": {
      "to": "user@example.com",
      "subject": "Welcome!",
      "body": "Thanks for signing up."
    }
  }'`;

export default function LandingPage() {
  return (
    <>
      <nav className="nav">
        <span className="nav-brand">Notify Engine</span>
        <div className="nav-links">
          <Link href="/login">Log in</Link>
          <Link href="/signup" className="btn btn-primary">
            Sign up
          </Link>
        </div>
      </nav>

      <div className="page">
        <section className="section">
          <h1>Send notifications from your API, not your inbox.</h1>
          <p className="lede">
            One API call triggers a notification to one of your users. We queue it, deliver it,
            retry it on failure, and give you a log of what happened — so you don&apos;t have to
            build that part yourself.
          </p>
          <div className="row">
            <Link href="/signup" className="btn btn-primary">
              Sign up for an API key
            </Link>
            <Link href="/login" className="btn">
              Log in
            </Link>
          </div>
        </section>

        <section className="section">
          <h2>How it works</h2>
          <div className="stack">
            <div className="card">
              <strong>1. Get an API key.</strong>
              <p>Sign up and we generate one for your account immediately.</p>
            </div>
            <div className="card">
              <strong>2. Call POST /v1/events.</strong>
              <p>
                Send an <code>idempotency_key</code>, an <code>event_type</code>, and a payload.
                Retries with the same key never double-send.
              </p>
            </div>
            <div className="card">
              <strong>3. We deliver it.</strong>
              <p>
                A worker sends the email, retries transient failures with backoff, and records
                every attempt. Watch it happen in your dashboard.
              </p>
            </div>
          </div>
        </section>

        <section className="section">
          <h2>Example</h2>
          <pre className="code-block">{CURL_EXAMPLE}</pre>
        </section>
      </div>
    </>
  );
}
