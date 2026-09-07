// Agent Tarmac — telemetry + update-check proxy (Cloudflare Worker).
//
// The desktop app calls GET /check?id=<uuid>&v=<version>&os=<os> once on launch
// (and daily thereafter). This Worker does two things in that one request:
//   1. Counts the launch — a total ping counter and a unique-install counter,
//      so we can see installs across BOTH the DMG and source-built users (the
//      GitHub download badge only sees DMG downloads).
//   2. Returns the latest GitHub release JSON in the exact shape the app's
//      update check expects, cached to spare the GitHub rate limit.
//
// Privacy: the only thing received is a random install id the app generates
// locally (no account/machine/user identifier), the app version, and the OS.
// We never receive or store an IP-to-identity mapping, file paths, or session
// content. `id` exists solely to tell "new install" from "same install again".
// Users can disable the ping entirely with AGENT_TARMAC_NO_TELEMETRY=1.

const REPO = "aknakshay/Agent-Tarmac";
const GH_LATEST = `https://api.github.com/repos/${REPO}/releases/latest`;
const GH_CACHE_TTL_SECONDS = 600; // 10 min — plenty below GitHub's rate limit

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/stats") {
      return stats(url, env);
    }
    if (url.pathname !== "/check") {
      return new Response("Agent Tarmac telemetry\n", { status: 200 });
    }

    // Count without blocking the response the app is waiting on.
    ctx.waitUntil(record(url, env));

    const body = await latestReleaseJson(env);
    return new Response(body, {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  },
};

// --- counting -------------------------------------------------------------
// KV read-modify-write isn't atomic, so at high concurrency a few increments
// can be lost. At this project's scale that's an acceptable approximation, and
// the unique-install count (keyed per id) is naturally idempotent.
async function record(url, env) {
  const kv = env.TARMAC_KV;
  if (!kv) return;

  const id = (url.searchParams.get("id") || "").replace(/[^A-Za-z0-9-]/g, "").slice(0, 64);
  const today = new Date().toISOString().slice(0, 10);

  await bump(kv, "count:total");

  if (id) {
    const firstSeen = await kv.get(`install:${id}`);
    if (!firstSeen) {
      await bump(kv, "count:installs");
    }
    // Only bump the daily-active counter the first time this install pings today.
    if (firstSeen !== today) {
      await bump(kv, `dau:${today}`, 60 * 60 * 24 * 120);
    }
    await kv.put(`install:${id}`, today);
  }
}

async function bump(kv, key, ttlSeconds) {
  const next = String((parseInt((await kv.get(key)) || "0", 10) || 0) + 1);
  await kv.put(key, next, ttlSeconds ? { expirationTtl: ttlSeconds } : undefined);
}

// --- stats readout --------------------------------------------------------
// GET /stats?token=<STATS_TOKEN> -> { total, installs, today }. Token-gated so
// the raw numbers aren't public; set it with `wrangler secret put STATS_TOKEN`.
async function stats(url, env) {
  if (env.STATS_TOKEN && url.searchParams.get("token") !== env.STATS_TOKEN) {
    return new Response("forbidden", { status: 403 });
  }
  const kv = env.TARMAC_KV;
  const today = new Date().toISOString().slice(0, 10);
  const body = {
    total: parseInt((kv && (await kv.get("count:total"))) || "0", 10),
    installs: parseInt((kv && (await kv.get("count:installs"))) || "0", 10),
    today: parseInt((kv && (await kv.get(`dau:${today}`))) || "0", 10),
  };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

// --- GitHub passthrough (cached) -----------------------------------------
async function latestReleaseJson(env) {
  const kv = env.TARMAC_KV;
  if (kv) {
    const cached = await kv.get("gh:latest");
    if (cached) return cached;
  }

  const headers = { "User-Agent": "agent-tarmac-telemetry", Accept: "application/vnd.github+json" };
  // Optional: raises the GitHub rate limit from 60/hr to 5000/hr.
  if (env.GITHUB_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;

  const resp = await fetch(GH_LATEST, { headers });
  if (!resp.ok) {
    // Never break the app's update check — hand back a harmless empty object.
    return "{}";
  }
  const value = await resp.json();
  const slim = JSON.stringify({ tag_name: value.tag_name, html_url: value.html_url });
  if (kv) {
    await kv.put("gh:latest", slim, { expirationTtl: GH_CACHE_TTL_SECONDS });
  }
  return slim;
}
