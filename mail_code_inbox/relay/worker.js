// Forward Email sends the public webhook here. Only its published MX hosts may
// relay a message; the secret used to reach Home Assistant stays in Worker secrets.
const IP_LIST_URL = "https://forwardemail.net/ips.json";
const MAX_WEBHOOK_BYTES = 12 * 1024 * 1024;
let trustedAddresses = new Set();
let refreshAfter = 0;

async function isForwardEmailAddress(ip) {
  if (!ip) return false;
  if (Date.now() >= refreshAfter) {
    const response = await fetch(IP_LIST_URL, { cf: { cacheTtl: 900, cacheEverything: true } });
    if (!response.ok) throw new Error("Could not load Forward Email IP list");
    const hosts = await response.json();
    const mxHosts = hosts.filter((host) => host.hostname === "mx1.forwardemail.net" || host.hostname === "mx2.forwardemail.net");
    if (mxHosts.length !== 2) throw new Error("Forward Email IP list is incomplete");
    trustedAddresses = new Set(mxHosts.flatMap((host) => [...host.ipv4, ...host.ipv6]));
    refreshAfter = Date.now() + 15 * 60_000;
  }
  return trustedAddresses.has(ip);
}

export default {
  async fetch(request, env) {
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    try {
      if (!await isForwardEmailAddress(request.headers.get("cf-connecting-ip"))) {
        return new Response("Forbidden", { status: 403 });
      }
      if (Number(request.headers.get("content-length")) > MAX_WEBHOOK_BYTES) {
        return new Response("Too large", { status: 413 });
      }
      const body = await request.text();
      if (new TextEncoder().encode(body).byteLength > MAX_WEBHOOK_BYTES) {
        return new Response("Too large", { status: 413 });
      }
      const payload = JSON.parse(body);
      if (typeof payload.raw !== "string" || !Array.isArray(payload.recipients)) {
        return new Response("Invalid payload", { status: 400 });
      }
      const inboxUrl = new URL(env.INBOX_URL);
      if (inboxUrl.protocol !== "https:") throw new Error("INBOX_URL must use HTTPS");
      const upstream = await fetch(inboxUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Relay-Key": env.RELAY_KEY },
        body: JSON.stringify({
          raw: payload.raw,
          recipients: payload.recipients,
          sender: payload.session?.sender || "",
        }),
      });
      if (!upstream.ok) {
        console.error("Home Assistant inbox returned", upstream.status);
        return new Response("Inbox unavailable", { status: 503 });
      }
      return new Response("OK", { status: 200 });
    } catch (error) {
      console.error("Email relay failed", error);
      return new Response("Relay unavailable", { status: 503 });
    }
  },
};
