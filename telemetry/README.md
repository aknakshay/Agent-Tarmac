# Agent Tarmac telemetry Worker

A tiny [Cloudflare Worker](https://developers.cloudflare.com/workers/) that counts
anonymous app launches and doubles as the update-check endpoint. It exists because
the GitHub download badge only sees `.dmg` downloads — it can't count people who
build from source. Every running copy of the app calls this once on launch, so it
captures **both** acquisition paths in one number.

It receives only: a random install id the app generates locally, the app version,
and the OS. No account, machine, user identifier, file paths, or session content.
See the header of [`worker.js`](./worker.js) and the privacy note in the root README.

## Endpoints

- `GET /check?id=<uuid>&v=<version>&os=<os>` — counts the launch, returns
  `{ "tag_name": "...", "html_url": "..." }` (the shape the app's update check parses).
- `GET /stats?token=<STATS_TOKEN>` — `{ total, installs, today }`. Token-gated.

## Deploy

```sh
cd telemetry
npm install -g wrangler        # or: npx wrangler ...
wrangler login

# 1. Create the KV namespace and paste the printed id into wrangler.toml
wrangler kv namespace create TARMAC_KV

# 2. Set secrets (never committed)
wrangler secret put STATS_TOKEN      # any long random string; needed to read /stats
wrangler secret put GITHUB_TOKEN     # optional: a repo-scoped PAT, raises GH rate limit

# 3. Ship it
wrangler deploy
```

`wrangler deploy` prints the Worker URL, e.g.
`https://agent-tarmac-telemetry.<subdomain>.workers.dev`.

## Turn it on in the app

In [`src-tauri/src/update_check.rs`](../src-tauri/src/update_check.rs), set:

```rust
const TELEMETRY_ENDPOINT: Option<&str> =
    Some("https://agent-tarmac-telemetry.<subdomain>.workers.dev/check");
```

Until that's `Some(...)`, the app checks GitHub directly and sends nothing.
Any failure against the Worker falls back to GitHub, so update checks never
break. Users can opt out at any time with `AGENT_TARMAC_NO_TELEMETRY=1`.

## Read the numbers

```sh
curl "https://agent-tarmac-telemetry.<subdomain>.workers.dev/stats?token=YOUR_STATS_TOKEN"
# {"total":123,"installs":47,"today":5}
```
