import assert from "node:assert/strict";
import test from "node:test";
import relay from "./worker.js";

test("only Forward Email MX servers can relay to Home Assistant", async () => {
  const originalFetch = globalThis.fetch;
  let forwarded;
  globalThis.fetch = async (target, options) => {
    if (String(target) === "https://forwardemail.net/ips.json") {
      return Response.json([
        { hostname: "mx1.forwardemail.net", ipv4: ["192.0.2.10"], ipv6: [] },
        { hostname: "mx2.forwardemail.net", ipv4: ["192.0.2.11"], ipv6: [] },
      ]);
    }
    forwarded = { target: String(target), options };
    return new Response("OK");
  };
  const env = { INBOX_URL: "https://inbox-hook.example.net/api/inbound/forward-email", RELAY_KEY: "private-relay-secret" };
  const payload = { raw: "Subject: Code\r\n\r\nCode 123456", recipients: ["alice@bmssmart.uz"], session: { sender: "service@example.net" } };
  const request = (ip) => new Request("https://relay.example.net/", {
    method: "POST",
    headers: { "CF-Connecting-IP": ip, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  try {
    assert.equal((await relay.fetch(request("198.51.100.2"), env)).status, 403);
    assert.equal(forwarded, undefined);
    assert.equal((await relay.fetch(request("192.0.2.10"), env)).status, 200);
    assert.equal(forwarded.target, env.INBOX_URL);
    assert.equal(forwarded.options.headers["X-Relay-Key"], env.RELAY_KEY);
    assert.deepEqual(JSON.parse(forwarded.options.body), {
      raw: payload.raw,
      recipients: payload.recipients,
      sender: "service@example.net",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
