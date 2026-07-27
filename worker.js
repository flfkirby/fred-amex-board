const MONTH_TABS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WHO_MAP = { K: "fred", B: "fra", F: "joint" };
const BENCHMARK = 2800;

// ---------------------------------------------------------------- auth
async function getAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(
    JSON.stringify({
      iss: env.GOOGLE_SA_EMAIL,
      scope: "https://www.googleapis.com/auth/spreadsheets.readonly",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    })
  );
  const input = `${header}.${claims}`;
  const key = await importPrivateKey(env.GOOGLE_SA_KEY);
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(input)
  );
  const jwt = `${input}.${b64urlBytes(new Uint8Array(sig))}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  if (!res.ok) throw new Error(`token exchange failed: ${res.status} ${await res.text()}`);
  return (await res.json()).access_token;
}

async function importPrivateKey(raw) {
  let pem = String(raw).trim();
  // If the whole service-account JSON was pasted, pull out private_key
  if (pem.startsWith("{")) {
    try {
      pem = JSON.parse(pem).private_key || "";
    } catch {
      const m = pem.match(/"private_key"\s*:\s*"([^"]+)"/);
      if (m) pem = m[1];
    }
  }
  const body = pem
    .replace(/-----[^-]+-----/g, "") // any BEGIN/END lines
    .replace(/\\r|\\n/g, "") // escaped newlines from JSON strings
    .replace(/["']/g, "")
    .replace(/\s/g, "");
  if (!/^[A-Za-z0-9+/]+=*$/.test(body) || body.length < 100) {
    throw new Error(
      "GOOGLE_SA_KEY doesn't look like a valid private key — paste the private_key value from the service account JSON (BEGIN/END lines included is fine)"
    );
  }
  const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey(
    "pkcs8",
    der.buffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
}

const b64url = (s) => b64urlBytes(new TextEncoder().encode(s));
function b64urlBytes(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ---------------------------------------------------------------- sheet read
async function fetchSheet(env) {
  if (!env.GOOGLE_SA_EMAIL || !env.GOOGLE_SA_KEY) {
    throw new Error(
      "Google credentials not set — add GOOGLE_SA_EMAIL and GOOGLE_SA_KEY as Secrets under the Worker's Settings > Variables and Secrets"
    );
  }
  const token = await getAccessToken(env);
  // Which tabs exist?
  const metaRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${env.SHEET_ID}?fields=sheets.properties.title`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!metaRes.ok) throw new Error(`sheet metadata: ${metaRes.status} ${await metaRes.text()}`);
  const meta = await metaRes.json();
  const allTabs = (meta.sheets || []).map((s) => s.properties.title);
  // prefer canonical month-name ordering where titles match; keep sheet order otherwise
  const tabs = allTabs.sort((a, b) => {
    const ia = MONTH_TABS.indexOf(a.slice(0, 3));
    const ib = MONTH_TABS.indexOf(b.slice(0, 3));
    if (ia !== -1 && ib !== -1) return ia - ib;
    return allTabs.indexOf(a) - allTabs.indexOf(b);
  });
  if (!tabs.length) throw new Error("no tabs found");

  const ranges = tabs.map((t) => `ranges=${encodeURIComponent(`${t}!A1:N600`)}`).join("&");
  const valRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${env.SHEET_ID}/values:batchGet?${ranges}&valueRenderOption=UNFORMATTED_VALUE`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!valRes.ok) throw new Error(`sheet values: ${valRes.status} ${await valRes.text()}`);
  const vals = await valRes.json();

  return tabs.map((tab, i) => parseMonth(tab, vals.valueRanges[i]?.values || []));
}

// Columns: Date | Description | Card Member | Who | Account# | Amount | Category
function parseMonth(tab, rows) {
  const m = {
    month: tab,
    total: 0,
    fred: 0,
    fra: 0,
    joint: 0,
    categories: {},
    top: [],
  };
  if (!rows.length) return m;

  // Find header row (contains "Description" and "Amount")
  let headerIdx = rows.findIndex(
    (r) => r.some((c) => /description/i.test(String(c))) && r.some((c) => /amount/i.test(String(c)))
  );
  if (headerIdx === -1) headerIdx = 0;
  const header = rows[headerIdx].map((c) => String(c).toLowerCase());
  const col = (name, fallback) => {
    const i = header.findIndex((h) => h.includes(name));
    return i === -1 ? fallback : i;
  };
  const cDesc = col("description", 1);
  const cWho = col("who", 3);
  const cAmount = col("amount", 5);
  const cCat = col("category", 13);
  const cDate = col("date", 0);

  for (const r of rows.slice(headerIdx + 1)) {
    const desc = String(r[cDesc] ?? "").trim();
    const whoRaw = String(r[cWho] ?? "").trim().toUpperCase();
    const amount = Number(String(r[cAmount]).replace(/[£,]/g, ""));
    // Only K/B/F rows are transactions — summary rows and card payments have no Who code
    if (!WHO_MAP[whoRaw]) continue;
    if (!desc) continue;
    if (!Number.isFinite(amount) || amount === 0) continue;
    // charges are positive; negatives are refunds/credits and net off the totals

    const who = WHO_MAP[whoRaw];
    m.total += amount;
    m[who] += amount;
    // Tidy Amex's "General Purchases-Online Purchases" style names
    let cat = String(r[cCat] ?? "").trim() || "Uncategorised";
    cat = cat.split("-").pop().trim() || cat;
    m.categories[cat] = (m.categories[cat] || 0) + amount;
    if (amount > 0) m.top.push({ desc, amount, who });
  }

  m.categories = Object.entries(m.categories)
    .map(([name, amount]) => ({ name, amount: Math.round(amount) }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 6);
  m.top = m.top.sort((a, b) => b.amount - a.amount).slice(0, 6)
    .map((t) => ({ ...t, amount: Math.round(t.amount) }));
  m.total = Math.round(m.total);
  m.fred = Math.round(m.fred);
  m.fra = Math.round(m.fra);
  m.joint = Math.round(m.joint);
  return m;
}

// ---------------------------------------------------------------- worker
// Architecture matches fred-ops-board: single worker.js serving frontend,
// REST API, and MCP server. KV bound as AMEX_KV. Auth via BOARD_TOKEN
// (X-Board-Token header or ?key= param). Push to main auto-deploys via
// Cloudflare Workers Builds.

const CACHE_KEY = "amex:cache:v1";
const SETTINGS_KEY = "amex:settings";
const CACHE_TTL_MS = 10 * 60 * 1000;

function authed(request, url, env) {
  if (!env.BOARD_TOKEN) return true; // no token set yet — open (matches pre-auth ops board behaviour)
  return (
    url.searchParams.get("key") === env.BOARD_TOKEN ||
    request.headers.get("X-Board-Token") === env.BOARD_TOKEN
  );
}

async function getSettings(env) {
  const raw = await env.AMEX_KV.get(SETTINGS_KEY);
  const s = raw ? JSON.parse(raw) : {};
  return { benchmark: s.benchmark || BENCHMARK };
}

async function getData(env, fresh) {
  if (!fresh) {
    const raw = await env.AMEX_KV.get(CACHE_KEY);
    if (raw) {
      const cached = JSON.parse(raw);
      if (Date.now() - cached.ts < CACHE_TTL_MS) return { ...cached.data, cached: true };
    }
  }
  const months = (await fetchSheet(env)).filter((m) => m.total > 0);
  const settings = await getSettings(env);
  const data = {
    months,
    benchmark: settings.benchmark,
    generated: new Date().toISOString(),
  };
  await env.AMEX_KV.put(CACHE_KEY, JSON.stringify({ ts: Date.now(), data }));
  return data;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------- MCP server
// Streamable HTTP JSON-RPC at /mcp?key=TOKEN — same pattern as the ops board.
const MCP_TOOLS = [
  {
    name: "get_spend",
    description:
      "Read the full Amex spend board: every month's totals (total/fred/fra/joint), top categories, biggest transactions, plus running averages and the normal-month benchmark. Data comes live from the joint Amex Google Sheet (10-min cache).",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_month",
    description: "Read a single month's spend breakdown by tab name, e.g. 'Jul'.",
    inputSchema: {
      type: "object",
      properties: { month: { type: "string", description: "Month tab name, e.g. 'Jul'" } },
      required: ["month"],
    },
  },
  {
    name: "refresh_data",
    description: "Force a fresh read of the Google Sheet, bypassing the 10-minute cache, and return the updated spend board.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "set_benchmark",
    description: "Set the 'normal month' benchmark in GBP that the burn bar tracks against (currently defaults to 2800).",
    inputSchema: {
      type: "object",
      properties: { value: { type: "number", description: "Benchmark in GBP, e.g. 2800" } },
      required: ["value"],
    },
  },
];

function withAverages(data) {
  const n = data.months.length || 1;
  const avg = {};
  for (const k of ["total", "fred", "fra", "joint"]) {
    avg[k] = Math.round(data.months.reduce((s, m) => s + m[k], 0) / n);
  }
  return { ...data, averages: avg };
}

async function mcpToolCall(name, args, env) {
  switch (name) {
    case "get_spend":
      return withAverages(await getData(env, false));
    case "refresh_data":
      return withAverages(await getData(env, true));
    case "get_month": {
      const data = await getData(env, false);
      const m = data.months.find(
        (x) => x.month.toLowerCase() === String(args.month || "").slice(0, 3).toLowerCase()
      );
      if (!m) throw new Error(`No data for month '${args.month}'`);
      return m;
    }
    case "set_benchmark": {
      const value = Number(args.value);
      if (!Number.isFinite(value) || value <= 0) throw new Error("value must be a positive number");
      const settings = await getSettings(env);
      settings.benchmark = Math.round(value);
      await env.AMEX_KV.put(SETTINGS_KEY, JSON.stringify(settings));
      await env.AMEX_KV.delete(CACHE_KEY); // so the board picks it up immediately
      return { ok: true, benchmark: settings.benchmark };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function handleMcp(request, env) {
  if (request.method !== "POST") return json({ error: "POST only" }, 405);
  let rpc;
  try {
    rpc = await request.json();
  } catch {
    return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
  }
  const { id, method, params } = rpc;
  const reply = (result) => json({ jsonrpc: "2.0", id, result });
  const fail = (code, message) => json({ jsonrpc: "2.0", id, error: { code, message } });

  try {
    if (method === "initialize") {
      return reply({
        protocolVersion: params?.protocolVersion || "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "amex-board", version: "1.0.0" },
      });
    }
    if (method === "notifications/initialized" || method === "ping") {
      return method === "ping" ? reply({}) : new Response(null, { status: 202 });
    }
    if (method === "tools/list") return reply({ tools: MCP_TOOLS });
    if (method === "tools/call") {
      const result = await mcpToolCall(params.name, params.arguments || {}, env);
      return reply({ content: [{ type: "text", text: JSON.stringify(result) }] });
    }
    return fail(-32601, `Method not found: ${method}`);
  } catch (e) {
    return fail(-32000, String(e.message || e));
  }
}

// ---------------------------------------------------------------- routes
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (!authed(request, url, env)) return new Response("Not found", { status: 404 });

    if (url.pathname === "/mcp") return handleMcp(request, env);

    if (url.pathname === "/api/data") {
      try {
        return json(await getData(env, url.searchParams.get("fresh") === "1"));
      } catch (e) {
        return json({ error: String(e.message || e) }, 500);
      }
    }

    if (url.pathname === "/api/months") {
      try {
        const data = await getData(env, false);
        return json({ months: data.months.map((m) => m.month), generated: data.generated });
      } catch (e) {
        return json({ error: String(e.message || e) }, 500);
      }
    }

    return new Response(HTML, { headers: { "Content-Type": "text/html;charset=utf-8" } });
  },
};
// ---------------------------------------------------------------- dashboard
const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Joint Amex — spend board</title>
<style>
  :root {
    --bg:#0e1116; --panel:#141925; --line:#1a1f2a; --line2:#232936;
    --ink:#e8e4da; --dim:#7d8494; --mid:#aab2c0;
    --gold:#c9a227; --fred:#5fb4a2; --fra:#c98bb9; --joint:#8a93a6; --bad:#d4756b;
  }
  * { box-sizing:border-box; margin:0; }
  body {
    background:var(--bg); color:var(--ink);
    font-family:'Avenir Next','Segoe UI',system-ui,sans-serif;
    padding:28px 22px 60px; max-width:860px; margin:0 auto;
  }
  header { display:flex; justify-content:space-between; align-items:baseline;
    border-bottom:1px solid var(--line2); padding-bottom:14px; margin-bottom:20px; }
  .eyebrow { font-size:11px; letter-spacing:.22em; text-transform:uppercase; color:var(--gold); }
  h1 { font-size:26px; font-weight:600; margin-top:4px; }
  button { background:var(--gold); color:var(--bg); border:none; border-radius:4px;
    padding:9px 16px; font-size:13px; font-weight:600; cursor:pointer; letter-spacing:.05em; }
  button:disabled { background:var(--line); color:var(--dim); cursor:default; }
  .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); gap:12px; }
  .card { background:var(--panel); border-radius:6px; padding:14px 16px; border-top:2px solid var(--dim); }
  .card .label { font-size:10px; letter-spacing:.14em; text-transform:uppercase; color:var(--dim); }
  .card .value { font-size:24px; font-weight:600; font-variant-numeric:tabular-nums; margin-top:4px; }
  .card .sub { font-size:11px; color:var(--dim); margin-top:2px; }
  h2 { font-size:11px; letter-spacing:.18em; text-transform:uppercase; color:var(--gold);
    margin:30px 0 12px; font-weight:600; }
  .burnwrap { margin:18px 0 6px; }
  .burnhead { display:flex; justify-content:space-between; font-size:11px; letter-spacing:.12em;
    text-transform:uppercase; color:var(--dim); margin-bottom:6px; }
  .burn { height:14px; background:var(--line); border-radius:3px; position:relative; overflow:hidden; }
  .burn .fill { height:100%; transition:width .6s ease; }
  .burn .mark { position:absolute; top:0; bottom:0; width:2px; background:var(--gold); }
  .trend { display:flex; gap:10px; align-items:flex-end; height:150px; }
  .trend .col { flex:1; background:none; border:none; padding:0; display:flex; flex-direction:column;
    justify-content:flex-end; gap:6px; height:100%; cursor:pointer; }
  .trend .amt { font-size:10px; color:var(--dim); font-variant-numeric:tabular-nums; }
  .trend .bar { border-radius:3px 3px 0 0; display:flex; flex-direction:column-reverse;
    overflow:hidden; min-height:4px; outline:1px solid transparent; }
  .trend .mon { font-size:11px; letter-spacing:.1em; text-transform:uppercase; color:var(--dim); }
  .trend .sel .amt { color:var(--gold); } .trend .sel .mon { color:var(--ink); }
  .trend .sel .bar { outline-color:var(--gold); }
  .legend { display:flex; gap:16px; margin-top:10px; font-size:11px; color:var(--dim); }
  .sw { display:inline-block; width:8px; height:8px; border-radius:2px; margin-right:5px; vertical-align:0; }
  .detail { display:grid; grid-template-columns:repeat(auto-fit,minmax(280px,1fr)); gap:28px; margin-top:8px; }
  .catrow { margin-bottom:10px; }
  .catrow .head { display:flex; justify-content:space-between; font-size:13px; margin-bottom:4px; }
  .catrow .head span:last-child { font-variant-numeric:tabular-nums; color:var(--mid); }
  .catrow .track { height:5px; background:var(--line); border-radius:3px; }
  .catrow .fill { height:100%; background:var(--gold); opacity:.8; border-radius:3px; }
  .txrow { display:flex; justify-content:space-between; align-items:center; padding:9px 0;
    border-bottom:1px solid var(--line); font-size:13px; }
  .txrow span:last-child { font-variant-numeric:tabular-nums; color:var(--mid); }
  .status { color:var(--dim); font-size:14px; line-height:1.6; }
  .error { background:#2a1a1a; border:1px solid rgba(212,117,107,.27); border-radius:6px;
    padding:14px; font-size:13px; color:var(--bad); }
  @media (prefers-reduced-motion:reduce){ .burn .fill{transition:none} }
</style>
</head>
<body>
<header>
  <div>
    <div class="eyebrow">Household ledger</div>
    <h1>Joint Amex — spend board</h1>
  </div>
  <button id="refresh">Refresh</button>
</header>
<div id="app"><p class="status">Loading…</p></div>
<script>
const WHO = { fred:{label:"Fred",v:"--fred"}, fra:{label:"Francesca",v:"--fra"}, joint:{label:"Joint",v:"--joint"} };
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const fmt = (n) => "£" + Math.round(n).toLocaleString("en-GB");
let DATA = null, SEL = 0;
const KEY = new URLSearchParams(location.search).get("key") || "";

async function load(fresh) {
  const app = document.getElementById("app");
  app.innerHTML = '<p class="status">Reading sheet…</p>';
  try {
    const res = await fetch("/api/data" + (fresh ? "?fresh=1&" : "?") + "key=" + encodeURIComponent(KEY),
      { headers: { "X-Board-Token": KEY } });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    DATA = data; SEL = data.months.length - 1;
    render();
  } catch (e) {
    app.innerHTML = '<div class="error">Couldn\\u2019t read the sheet: ' + e.message +
      '. Check the service account still has viewer access, then refresh.</div>';
  }
}

function render() {
  const { months, benchmark } = DATA;
  const cur = months[SEL];
  const n = months.length;
  const avg = (k) => months.reduce((s,m)=>s+m[k],0)/n;
  const over = cur.total > benchmark;
  const max = Math.max(...months.map(m=>m.total), benchmark);
  const catMax = Math.max(...cur.categories.map(c=>c.amount), 1);

  document.getElementById("app").innerHTML =
    '<div class="cards">' +
      card(cur.month + " total", cur.total, "var(--gold)", null) +
      card("Fred", cur.fred, "var(--fred)", avg("fred")) +
      card("Francesca", cur.fra, "var(--fra)", avg("fra")) +
      card("Joint", cur.joint, "var(--joint)", avg("joint")) +
    '</div>' +
    '<div class="burnwrap"><div class="burnhead">' +
      '<span>This month vs normal (' + fmt(benchmark) + ')</span>' +
      '<span style="color:' + (over ? "var(--bad)" : "var(--fred)") + '">' +
        (over ? "+" : "\\u2212") + fmt(Math.abs(cur.total - benchmark)) + '</span></div>' +
      '<div class="burn"><div class="fill" style="width:' +
        Math.min(cur.total/benchmark*100,130)/1.3 + '%;background:' +
        (over ? "linear-gradient(90deg,#c9a227,#d4756b)" : "linear-gradient(90deg,#3d6b5f,#5fb4a2)") +
      '"></div><div class="mark" style="left:' + (100/1.3) + '%"></div></div></div>' +
    '<h2>Trend</h2><div class="trend">' + months.map((m,i)=>trendCol(m,i,max)).join("") + '</div>' +
    '<div class="legend">' + Object.entries(WHO).map(([k,w]) =>
      '<span><span class="sw" style="background:var(' + w.v + ')"></span>' + w.label + '</span>').join("") + '</div>' +
    '<div class="detail"><div><h2>' + cur.month + ' \\u2014 top categories</h2>' +
      cur.categories.map(c =>
        '<div class="catrow"><div class="head"><span>' + esc(c.name) + '</span><span>' + fmt(c.amount) +
        '</span></div><div class="track"><div class="fill" style="width:' + (c.amount/catMax*100) + '%"></div></div></div>'
      ).join("") + '</div>' +
    '<div><h2>' + cur.month + ' \\u2014 biggest transactions</h2>' +
      cur.top.map(t =>
        '<div class="txrow"><span><span class="sw" style="background:var(--' + t.who + ')"></span>' +
        esc(t.desc) + '</span><span>' + fmt(t.amount) + '</span></div>'
      ).join("") + '</div></div>';

  document.querySelectorAll(".trend .col").forEach((el,i) =>
    el.addEventListener("click", () => { SEL = i; render(); }));
}

function card(label, value, color, avg) {
  return '<div class="card" style="border-top-color:' + color + '">' +
    '<div class="label">' + label + '</div><div class="value">' + fmt(value) + '</div>' +
    (avg != null ? '<div class="sub">avg ' + fmt(avg) + '</div>' : '') + '</div>';
}
function trendCol(m, i, max) {
  const segs = ["fred","fra","joint"].map(k =>
    '<div style="height:' + (m[k]/m.total*100) + '%;background:var(--' + k + ');opacity:' +
    (i===SEL?1:.55) + '"></div>').join("");
  return '<button class="col' + (i===SEL?" sel":"") + '"><div class="amt">' + fmt(m.total) +
    '</div><div class="bar" style="height:' + (m.total/max*100) + '%">' + segs +
    '</div><div class="mon">' + m.month + '</div></button>';
}
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));

document.getElementById("refresh").addEventListener("click", () => load(true));
load(false);
</script>
</body>
</html>`;
