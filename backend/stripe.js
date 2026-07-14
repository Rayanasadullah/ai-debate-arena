// backend/stripe.js — Stripe subscriptions via the REST API (Section 5).
//
// Dependency-free on purpose, matching feedback.js (Resend) and admin.js
// (Supabase): plain `fetch` against api.stripe.com + node:crypto for webhook
// signature verification, so there's no SDK to install and it runs the same
// under Deno and Node.
//
// Uses Stripe HOSTED Checkout (redirect to a Stripe-hosted page), so the
// SECRET key lives server-side only and no publishable key is needed in the
// browser. Card + PayPal are offered automatically based on what's enabled in
// the Stripe Dashboard (enable PayPal there for it to appear) — we don't pin
// payment_method_types, which is Stripe's recommended "automatic payment
// methods" behavior.

import crypto from "node:crypto";

const SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const PRICE_CENTS = Number(process.env.STRIPE_PRICE_CENTS) || 1000; // $10.00 / month

export function stripeConfigured() {
  return Boolean(SECRET_KEY);
}

// Stripe wants application/x-www-form-urlencoded with bracket notation for
// nested fields; URLSearchParams encodes keys/values correctly for that.
async function stripeFetch(path, params) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) body.append(k, String(v));
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Stripe ${res.status}: ${data?.error?.message || "request failed"}`);
  }
  return data;
}

// Create a subscription Checkout Session for this signed-in user. Returns the
// hosted-checkout URL to redirect them to. client_reference_id + metadata carry
// our Supabase user id so the webhook can map the subscription back to them.
export async function createCheckoutSession({ userId, email, successUrl, cancelUrl }) {
  return stripeFetch("checkout/sessions", {
    mode: "subscription",
    client_reference_id: userId,
    ...(email ? { customer_email: email } : {}),
    "line_items[0][quantity]": 1,
    "line_items[0][price_data][currency]": "usd",
    "line_items[0][price_data][unit_amount]": PRICE_CENTS,
    "line_items[0][price_data][recurring][interval]": "month",
    "line_items[0][price_data][product_data][name]": "AI Debate Arena Pro",
    "subscription_data[metadata][user_id]": userId,
    "metadata[user_id]": userId,
    success_url: successUrl,
    cancel_url: cancelUrl,
    allow_promotion_codes: "true",
  });
}

// Stripe-hosted billing portal so a subscriber can update payment method or
// cancel. Needs the Stripe customer id we stored from the first checkout.
export async function createBillingPortalSession({ customerId, returnUrl }) {
  return stripeFetch("billing_portal/sessions", {
    customer: customerId,
    return_url: returnUrl,
  });
}

// Verify a webhook payload against the Stripe-Signature header and return the
// parsed event. Throws on any mismatch. Implements Stripe's documented scheme:
// signedPayload = `${t}.${rawBody}`, HMAC-SHA256 with the endpoint secret,
// compared timing-safely to the v1 signature, with a 5-minute replay window.
export function verifyWebhook(rawBody, sigHeader) {
  if (!WEBHOOK_SECRET) throw new Error("STRIPE_WEBHOOK_SECRET not set");
  if (!sigHeader) throw new Error("missing Stripe-Signature header");

  const parts = Object.fromEntries(
    String(sigHeader)
      .split(",")
      .map((kv) => kv.split("=").map((s) => s.trim()))
  );
  const timestamp = parts.t;
  const signature = parts.v1;
  if (!timestamp || !signature) throw new Error("malformed Stripe-Signature");

  // Replay protection — reject payloads older than 5 minutes.
  const ageSec = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(ageSec) || ageSec > 300) throw new Error("timestamp outside tolerance");

  const expected = crypto
    .createHmac("sha256", WEBHOOK_SECRET)
    .update(`${timestamp}.${rawBody}`, "utf8")
    .digest("hex");

  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new Error("signature mismatch");
  }
  return JSON.parse(rawBody);
}
