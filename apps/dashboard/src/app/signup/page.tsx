"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { supabase } from "@/lib/supabase-client";
import { signup } from "@/lib/api-client";

export default function SignupPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [needsConfirmation, setNeedsConfirmation] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setPending(true);

    try {
      const { data, error: signUpError } = await supabase.auth.signUp({ email, password });

      if (signUpError) {
        setError(signUpError.message);
        return;
      }

      if (!data.session) {
        setNeedsConfirmation(true);
        return;
      }

      const result = await signup(data.session.access_token, name || undefined);

      if (result.apiKey) {
        sessionStorage.setItem("notifyEngine:justIssuedApiKey", result.apiKey);
      }

      router.push("/dashboard");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setPending(false);
    }
  }

  if (needsConfirmation) {
    return (
      <div className="page" style={{ maxWidth: 420 }}>
        <h1>Check your email</h1>
        <p>We sent a confirmation link to {email}. Confirm your address, then log in.</p>
        <Link href="/login" className="btn btn-primary" style={{ marginTop: "1.5rem" }}>
          Go to log in
        </Link>
      </div>
    );
  }

  return (
    <div className="page" style={{ maxWidth: 420 }}>
      <h1>Create your account</h1>
      <p className="lede" style={{ marginBottom: "1.5rem" }}>
        You&apos;ll get an API key immediately after signing up.
      </p>

      <form onSubmit={handleSubmit}>
        {error && <div className="form-error">{error}</div>}

        <div className="field">
          <label htmlFor="name">Company / project name (optional)</label>
          <input id="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Inc." />
        </div>

        <div className="field">
          <label htmlFor="email">Email</label>
          <input
            id="email"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>

        <button type="submit" className="btn btn-primary btn-block" disabled={pending}>
          {pending ? "Creating account…" : "Sign up"}
        </button>
      </form>

      <p className="muted" style={{ marginTop: "1.5rem" }}>
        Already have an account? <Link href="/login">Log in</Link>
      </p>
    </div>
  );
}
