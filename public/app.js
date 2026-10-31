const ACTIVITY_THROTTLE_MS = 30_000;
const POLL_MS = 2_000;

const $ = (id) => document.getElementById(id);
const seatId = () => encodeURIComponent($("seat").value);

let sessionDeadline = null;
let holdDeadline = null;
let lastActivity = 0;

// textContent everywhere: names and server text must never be parsed as HTML.
function log(label, status, body) {
  const line = document.createElement("li");
  line.textContent = `${label} -> ${status} ${body ? JSON.stringify(body) : ""}`;
  $("log").prepend(line);
}

async function call(label, path, init = {}) {
  const response = await fetch(path, init);
  const body = await response.json().catch(() => null);
  log(label, response.status, body);
  if (response.status === 401) signedOut();
  return { status: response.status, body };
}

const json = (value) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(value),
});

function signedOut() {
  sessionDeadline = null;
  $("user").textContent = "nobody";
}

function showSeat({ state, expiresInSeconds, confirmed }) {
  if (state) $("seat-state").textContent = confirmed ? "mine (confirmed)" : state;
  holdDeadline = expiresInSeconds ? Date.now() + expiresInSeconds * 1000 : null;
}

async function refresh() {
  if (sessionDeadline === null) return;
  const response = await fetch(`/seats/${seatId()}/status`);
  if (response.status === 401) return signedOut();
  if (response.ok) showSeat(await response.json());
}

async function intent() {
  const { body } = await call("intent", `/seats/${seatId()}/intents`, { method: "POST" });
  return body?.intent ?? "";
}

async function reserve(waitMs = 0, lease = false) {
  const token = await intent();
  const { body } = await call("reserve", `/seats/${seatId()}/reservations?waitMs=${waitMs}&lease=${lease}`, {
    method: "POST",
    headers: { "idempotency-token": token },
  });
  if (body) showSeat(body.result === "taken" ? { state: "taken" } : body);
}

// A real click or key press rolls the session and hold. Polling never does.
async function activity() {
  if (sessionDeadline === null || Date.now() - lastActivity < ACTIVITY_THROTTLE_MS) return;
  lastActivity = Date.now();
  const response = await fetch(`/seats/${seatId()}/heartbeat`, { method: "POST" });
  if (!response.ok) return;
  const body = await response.json();
  sessionDeadline = Date.now() + body.sessionExpiresInSeconds * 1000;
  showSeat(body);
}

const countdown = (deadline) =>
  deadline === null ? "-" : `${Math.max(0, Math.round((deadline - Date.now()) / 1000))}s`;

$("login").addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = new FormData(event.target).get("name");
  const { status, body } = await call("login", "/session", json({ name }));
  if (status !== 201) return;
  $("user").textContent = body.user;
  sessionDeadline = Date.now() + body.expiresInSeconds * 1000;
  refresh();
});

$("logout").addEventListener("click", async () => {
  await call("logout", "/session", { method: "DELETE" });
  signedOut();
});

$("reserve").addEventListener("click", () => reserve());
$("wait").addEventListener("click", () => reserve(30_000));
$("hold").addEventListener("click", () => reserve(0, true));
$("pay").addEventListener("click", async () => {
  await call("pay", `/seats/${seatId()}/payment`, { method: "POST" });
  refresh();
});
$("release").addEventListener("click", async () => {
  await call("release", `/seats/${seatId()}/reservations`, { method: "DELETE" });
  refresh();
});

const attacks = [
  ["Script tag as name (201, inert)", async () => {
    const payload = `<img src=x onerror="document.title='HACKED'">`;
    const { status, body } = await call("xss login", "/session", json({ name: payload }));
    if (status !== 201) return;
    $("user").textContent = body.user;
    sessionDeadline = Date.now() + body.expiresInSeconds * 1000;
  }],
  ["SQL as name (201, just text)", () => call("sql name", "/session", json({ name: "' OR 1=1; --" }))],
  ["Empty name (400)", () => call("empty name", "/session", json({ name: "" }))],
  ["Object as name (400)", () => call("object name", "/session", json({ name: { $ne: null } }))],
  ["Name over 64 chars (400)", () => call("long name", "/session", json({ name: "a".repeat(65) }))],
  ["Body over 16KB (413)", () => call("big body", "/session", json({ name: "a".repeat(20_000) }))],
  ["Forged intent (403)", () => call("forged intent", `/seats/${seatId()}/reservations`, {
    method: "POST",
    headers: { "idempotency-token": "e30.e30.forged" },
  })],
  ["Tampered intent signature (403)", async () => {
    const token = await intent();
    const flipped = token.slice(0, -2) + (token.endsWith("AA") ? "BB" : "AA");
    return call("tampered intent", `/seats/${seatId()}/reservations`, {
      method: "POST",
      headers: { "idempotency-token": flipped },
    });
  }],
  ["Path traversal seat (404)", () => call("traversal", `/seats/${encodeURIComponent("../../etc/passwd")}/status`)],
];

for (const [label, run] of attacks) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.addEventListener("click", run);
  $("attacks").append(button);
}

for (const type of ["pointerdown", "keydown"]) {
  document.addEventListener(type, activity, { passive: true });
}

setInterval(() => {
  $("session-left").textContent = countdown(sessionDeadline);
  $("hold-left").textContent = countdown(holdDeadline);
}, 1000);
setInterval(refresh, POLL_MS);

(async () => {
  const response = await fetch("/session");
  if (!response.ok) return;
  const body = await response.json();
  $("user").textContent = body.user;
  sessionDeadline = Date.now() + body.expiresInSeconds * 1000;
  refresh();
})();
