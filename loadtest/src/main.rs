//! Black-box load test for the seat race server. It starts the server, attacks
//! it over HTTP only, and exits non-zero if any guarantee breaks.

use std::path::PathBuf;
use std::process::{Child, Command, ExitCode, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, AtomicU64, AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use clap::Parser;
use futures::{StreamExt, stream};
use reqwest::{Client, Method, StatusCode};
use serde_json::{Value, json};
use tokio::sync::Barrier;
use tokio::time::{sleep, sleep_until};

const SEATS: usize = 1000;
const HOLD_TTL_SECONDS: u64 = 2;
const RATE_CAPACITY: usize = 5;
const SETUP_CONCURRENCY: usize = 32;
const CONFIRMED_SEATS: usize = 20;
const WATCHDOG: Duration = Duration::from_secs(120);
const GREEDY_USERS: usize = 8;
const PAY_STEP_MS: u64 = 25;
const SPAM_LEAD: Duration = Duration::from_millis(200);
const SPAM_TAIL: Duration = Duration::from_millis(800);

#[derive(Parser, Clone)]
#[command(about = "Load test for the seat race server")]
struct Args {
    /// Users racing for each seat matches the hono api.
    #[arg(long, default_value_t = 500)]
    users: usize,
    /// Seats raced in the main scenario.
    #[arg(long, default_value_t = 5)]
    rounds: usize,
    /// Worker threads, one port each.
    #[arg(long, default_value_t = 4)]
    workers: u16,
    /// First port the server binds.
    #[arg(long, default_value_t = 4300)]
    base_port: u16,
    /// Rounds of the pay versus expiry race.
    #[arg(long, default_value_t = 64)]
    pay_rounds: usize,
    /// Parked users in the release chain.
    #[arg(long, default_value_t = 40)]
    waiters: usize,
    /// Seconds of the sustained throughput scenario.
    #[arg(long, default_value_t = 5)]
    seconds: u64,
    /// Open connections in the sustained throughput scenario.
    #[arg(long, default_value_t = 64)]
    concurrency: usize,
}

/// Kills the server even when a scenario panics.
struct Server(Child);

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[derive(Clone)]
struct Api {
    http: Client,
    ports: Arc<Vec<u16>>,
    next_seat: Arc<AtomicUsize>,
}

#[derive(Clone)]
struct User {
    cookie: String,
}

struct Reply {
    status: StatusCode,
    replayed: bool,
    body: Value,
}

impl Api {
    fn port(&self, index: usize) -> u16 {
        self.ports[index % self.ports.len()]
    }

    fn seat(&self) -> String {
        format!("seat-{}", self.next_seat.fetch_add(1, Ordering::Relaxed))
    }

    async fn call(&self, port: u16, method: Method, path: &str, user: &User, token: Option<&str>) -> Reply {
        let mut request = self
            .http
            .request(method, format!("http://127.0.0.1:{port}{path}"))
            .header("cookie", &user.cookie);
        if let Some(token) = token {
            request = request.header("idempotency-token", token);
        }
        let response = request.send().await.expect("request failed");
        let status = response.status();
        let replayed = response.headers().contains_key("idempotent-replay");
        let text = response.text().await.unwrap_or_default();
        Reply { status, replayed, body: serde_json::from_str(&text).unwrap_or(Value::Null) }
    }

    async fn login(&self, name: String) -> User {
        let response = self
            .http
            .post(format!("http://127.0.0.1:{}/session", self.port(0)))
            .header("content-type", "application/json")
            .body(json!({ "name": name }).to_string())
            .send()
            .await
            .expect("login failed");
        assert_eq!(response.status(), StatusCode::CREATED, "login refused");
        let cookie = response.headers()["set-cookie"].to_str().unwrap();
        let cookie = cookie.split(';').next().unwrap().to_string();
        User { cookie }
    }

    async fn intent(&self, user: &User, seat: &str) -> String {
        let path = format!("/seats/{seat}/intents");
        let reply = self.call(self.port(0), Method::POST, &path, user, None).await;
        reply.body["intent"].as_str().expect("no intent issued").to_string()
    }

    async fn reserve(&self, port: u16, user: &User, seat: &str, intent: &str, wait_ms: u64) -> Reply {
        let path = format!("/seats/{seat}/reservations?waitMs={wait_ms}");
        self.call(port, Method::POST, &path, user, Some(intent)).await
    }

    /// Asks for a lease. Without one, a reservation is definite.
    async fn hold(&self, port: u16, user: &User, seat: &str, intent: &str) -> Reply {
        let path = format!("/seats/{seat}/reservations?lease=true");
        self.call(port, Method::POST, &path, user, Some(intent)).await
    }

    async fn state(&self, port: u16, user: &User, seat: &str) -> Value {
        let path = format!("/seats/{seat}/status");
        self.call(port, Method::GET, &path, user, None).await.body
    }

    /// Logs users in and fetches an intent for each, before any race starts.
    async fn prepare(&self, prefix: &str, count: usize, seat: &str) -> Vec<(User, String)> {
        stream::iter(0..count)
            .map(|i| async move {
                let user = self.login(format!("{prefix}-{i}")).await;
                let intent = self.intent(&user, seat).await;
                (user, intent)
            })
            .buffered(SETUP_CONCURRENCY)
            .collect()
            .await
    }
}

struct Report {
    checks: Vec<(String, bool, String)>,
}

impl Report {
    fn check(&mut self, name: &str, ok: bool, detail: String) {
        println!("{} {name}: {detail}", if ok { "PASS" } else { "FAIL" });
        self.checks.push((name.to_string(), ok, detail));
    }
}

fn count(statuses: &[u16], wanted: u16) -> usize {
    statuses.iter().filter(|status| **status == wanted).count()
}

/// Every user fires at one seat at once, spread evenly over the ports.
async fn race(api: &Api, args: &Args, report: &mut Report) {
    let mut failures = Vec::new();
    let mut wins_by_port = vec![0usize; api.ports.len()];
    let mut slowest = Duration::ZERO;

    for round in 0..args.rounds {
        let seat = api.seat();
        let racers = api.prepare(&format!("race{round}"), args.users, &seat).await;
        let barrier = Arc::new(Barrier::new(racers.len()));

        let tasks: Vec<_> = racers
            .iter()
            .cloned()
            .enumerate()
            .map(|(i, (user, intent))| {
                let (api, seat, barrier) = (api.clone(), seat.clone(), barrier.clone());
                tokio::spawn(async move {
                    barrier.wait().await;
                    let started = Instant::now();
                    let reply = api.reserve(api.port(i), &user, &seat, &intent, 0).await;
                    (i, reply.status.as_u16(), started.elapsed())
                })
            })
            .collect();

        let mut statuses = Vec::new();
        let mut winner = None;
        for task in tasks {
            let (i, status, elapsed) = task.await.unwrap();
            statuses.push(status);
            slowest = slowest.max(elapsed);
            if status == 201 {
                winner = Some(i);
            }
        }

        if count(&statuses, 201) != 1 || count(&statuses, 409) != args.users - 1 {
            failures.push(format!("{seat}: {} wins, {} taken", count(&statuses, 201), count(&statuses, 409)));
            continue;
        }

        let index = winner.unwrap();
        wins_by_port[index % api.ports.len()] += 1;
        for i in 0..api.ports.len() {
            let state = api.state(api.port(i), &racers[index].0, &seat).await;
            if state["state"] != "mine" {
                failures.push(format!("{seat}: port {} disagrees on the winner", api.port(i)));
            }
        }
    }

    report.check(
        "one winner per seat",
        failures.is_empty(),
        if failures.is_empty() {
            format!(
                "{} users on {} seats, wins by port {wins_by_port:?}, slowest {slowest:?}",
                args.users, args.rounds
            )
        } else {
            failures.join("; ")
        },
    );
}

/// One user hammers one intent on every port. Exactly one click may do the work.
async fn double_click(api: &Api, report: &mut Report) {
    let seat = api.seat();
    let (user, intent) = api.prepare("clicker", 1, &seat).await.remove(0);

    // Leaves one rate token, so any click charged twice surfaces as a 429.
    for _ in 1..RATE_CAPACITY {
        let other = api.seat();
        let other_intent = api.intent(&user, &other).await;
        api.reserve(api.port(0), &user, &other, &other_intent, 0).await;
    }

    let clicks = 64;
    let barrier = Arc::new(Barrier::new(clicks));

    let tasks: Vec<_> = (0..clicks)
        .map(|i| {
            let (api, seat, user, intent, barrier) =
                (api.clone(), seat.clone(), user.clone(), intent.clone(), barrier.clone());
            tokio::spawn(async move {
                barrier.wait().await;
                api.reserve(api.port(i), &user, &seat, &intent, 0).await
            })
        })
        .collect();

    let (mut wins, mut first) = (0, 0);
    for task in tasks {
        let reply = task.await.unwrap();
        wins += usize::from(reply.status == StatusCode::CREATED);
        first += usize::from(reply.status == StatusCode::CREATED && !reply.replayed);
    }
    report.check(
        "double clicks stay idempotent",
        wins == clicks && first == 1,
        format!("{wins}/{clicks} won, {first} did the work, the rest were replays"),
    );
}

/// Several users each burst at many seats. Every limit must hold across all ports.
async fn rate_limit(api: &Api, report: &mut Report) {
    let burst = 60;
    let mut shots = Vec::new();
    for u in 0..GREEDY_USERS {
        let user = api.login(format!("greedy-{u}")).await;
        for i in 0..burst {
            let seat = api.seat();
            let intent = api.intent(&user, &seat).await;
            shots.push((u, i, user.clone(), seat, intent));
        }
    }
    let barrier = Arc::new(Barrier::new(shots.len()));
    let started = Instant::now();

    let tasks: Vec<_> = shots
        .into_iter()
        .map(|(u, i, user, seat, intent)| {
            let (api, barrier) = (api.clone(), barrier.clone());
            tokio::spawn(async move {
                barrier.wait().await;
                (u, api.reserve(api.port(i), &user, &seat, &intent, 0).await.status.as_u16())
            })
        })
        .collect();

    let mut admitted = vec![0usize; GREEDY_USERS];
    let mut other = 0;
    for task in tasks {
        let (u, status) = task.await.unwrap();
        admitted[u] += usize::from(status == 201);
        other += usize::from(status != 201 && status != 429);
    }

    // The server refills one token per second while the burst is in flight.
    let allowed = RATE_CAPACITY + started.elapsed().as_secs() as usize + 1;
    let ok = other == 0 && admitted.iter().all(|&wins| wins >= RATE_CAPACITY && wins <= allowed);
    report.check(
        "rate limit holds across ports",
        ok,
        format!("admitted per user {admitted:?}, allowed at most {allowed}, {other} unexpected"),
    );
}

/// A lease lapses and exactly one parked user on another port takes it for good.
async fn expiry(api: &Api, report: &mut Report) {
    let seat = api.seat();
    let waiters = api.prepare("expiry", 21, &seat).await;
    let (holder, intent) = &waiters[0];
    assert_eq!(api.hold(api.port(0), holder, &seat, intent).await.status, StatusCode::CREATED);
    let started = Instant::now();

    let tasks: Vec<_> = waiters[1..]
        .iter()
        .cloned()
        .enumerate()
        .map(|(i, (user, intent))| {
            let (api, seat) = (api.clone(), seat.clone());
            tokio::spawn(async move {
                let status = api.reserve(api.port(i + 1), &user, &seat, &intent, 4000).await.status.as_u16();
                (status, started.elapsed())
            })
        })
        .collect();

    let (mut statuses, mut won_after) = (Vec::new(), None);
    for task in tasks {
        let (status, elapsed) = task.await.unwrap();
        statuses.push(status);
        if status == 201 {
            won_after = Some(elapsed);
        }
    }

    let late_enough = won_after.is_some_and(|elapsed| elapsed > Duration::from_millis(500));
    report.check(
        "expired hold goes to one waiter",
        count(&statuses, 201) == 1 && count(&statuses, 409) == 19 && late_enough,
        format!("{} of 20 waiters won, after {won_after:?}", count(&statuses, 201)),
    );
}

/// Alice pays around her deadline while Bob spams the seat. Exactly one may succeed.
async fn pay_versus_expiry(api: &Api, args: &Args, report: &mut Report) {
    let rounds = (0..args.pay_rounds).map(|round| {
        let api = api.clone();
        tokio::spawn(async move {
            let seat = api.seat();
            let players = api.prepare(&format!("pay{round}"), 2, &seat).await;
            let ((alice, alice_intent), (bob, bob_intent)) = (&players[0], &players[1]);
            let held = api.hold(api.port(0), alice, &seat, alice_intent).await;
            assert_eq!(held.status, StatusCode::CREATED);

            // The server counts deadlines in whole seconds, so watching the countdown
            // change reveals exactly when this hold lapses.
            let mut state = api.state(api.port(3), alice, &seat).await;
            while state["expiresInSeconds"] == held.body["expiresInSeconds"] {
                sleep(Duration::from_millis(2)).await;
                state = api.state(api.port(3), alice, &seat).await;
            }
            let deadline = Instant::now() + Duration::from_secs(state["expiresInSeconds"].as_u64().unwrap_or(0));

            // Lands every payment in the last moments, where a lost swap would show.
            let lead = Duration::from_millis(round as u64 % 16 * PAY_STEP_MS);
            let pay = async {
                sleep_until(deadline.checked_sub(lead).unwrap_or(deadline).into()).await;
                let path = format!("/seats/{seat}/payment");
                api.call(api.port(1), Method::POST, &path, alice, None).await.status
            };
            let spam = async {
                sleep_until(deadline.checked_sub(SPAM_LEAD).unwrap_or(deadline).into()).await;
                while Instant::now() < deadline + SPAM_TAIL {
                    let status = api.reserve(api.port(2), bob, &seat, bob_intent, 0).await.status;
                    if status == StatusCode::CREATED {
                        return true;
                    }
                    sleep(Duration::from_millis(5)).await;
                }
                false
            };
            let (paid, bob_won) = tokio::join!(pay, spam);
            let state = api.state(api.port(3), alice, &seat).await;
            (paid == StatusCode::OK, bob_won, state)
        })
    });

    let (mut paid, mut lapsed, mut violations) = (0, 0, Vec::new());
    for round in futures::future::join_all(rounds).await {
        let (alice_paid, bob_won, state) = round.unwrap();
        paid += usize::from(alice_paid);
        lapsed += usize::from(bob_won);
        let consistent = if alice_paid { state["confirmed"] == true } else { state["state"] == "taken" };
        if alice_paid == bob_won || !consistent {
            violations.push(format!("paid={alice_paid} bob={bob_won} state={state}"));
        }
    }

    // Without both outcomes the race never hit the deadline, so it proved nothing.
    report.check(
        "payment and expiry never both win",
        violations.is_empty() && paid > 0 && lapsed > 0,
        format!("{paid} paid in time, {lapsed} lapsed to the next user, {} violations {violations:?}", violations.len()),
    );
}

/// Parked users hand one seat down the line. Two holders at once would be a bug.
async fn release_chain(api: &Api, args: &Args, report: &mut Report) {
    let seat = api.seat();
    let players = api.prepare("chain", args.waiters + 1, &seat).await;
    let (first, intent) = &players[0];
    assert_eq!(api.hold(api.port(0), first, &seat, intent).await.status, StatusCode::CREATED);

    let occupied = Arc::new(AtomicI64::new(0));
    let overlaps = Arc::new(AtomicUsize::new(0));
    let tasks: Vec<_> = players[1..]
        .iter()
        .cloned()
        .enumerate()
        .map(|(i, (user, intent))| {
            let (api, seat, occupied, overlaps) = (api.clone(), seat.clone(), occupied.clone(), overlaps.clone());
            tokio::spawn(async move {
                // Port 0 stays empty and does all the releasing. A thread wakes its
                // own waiters directly, so only the broadcast can reach these.
                let port = api.ports[1 + i % (api.ports.len() - 1)];
                let path = format!("/seats/{seat}/reservations?waitMs=25000&lease=true");
                let status = api.call(port, Method::POST, &path, &user, Some(&intent)).await.status;
                if status != StatusCode::CREATED {
                    return false;
                }
                if occupied.fetch_add(1, Ordering::SeqCst) != 0 {
                    overlaps.fetch_add(1, Ordering::SeqCst);
                }
                sleep(Duration::from_millis(5)).await;
                occupied.fetch_sub(1, Ordering::SeqCst);
                let path = format!("/seats/{seat}/reservations");
                api.call(api.port(0), Method::DELETE, &path, &user, None).await.status == StatusCode::NO_CONTENT
            })
        })
        .collect();

    sleep(Duration::from_millis(300)).await;
    let started = Instant::now();
    let path = format!("/seats/{seat}/reservations");
    assert_eq!(api.call(api.port(0), Method::DELETE, &path, first, None).await.status, StatusCode::NO_CONTENT);

    let mut completed = 0;
    for task in tasks {
        completed += usize::from(task.await.unwrap());
    }
    let overlaps = overlaps.load(Ordering::SeqCst);
    report.check(
        "release chain has one holder at a time",
        completed == args.waiters && overlaps == 0,
        format!("{completed}/{} got the seat in turn, {overlaps} overlaps, in {:?}", args.waiters, started.elapsed()),
    );
}

/// Steady traffic, for numbers rather than for an invariant.
async fn throughput(api: &Api, args: &Args, report: &mut Report) {
    let seat = api.seat();
    let (user, intent) = api.prepare("steady", 1, &seat).await.remove(0);
    api.hold(api.port(0), &user, &seat, &intent).await;
    let errors = Arc::new(AtomicU64::new(0));
    let until = Instant::now() + Duration::from_secs(args.seconds);

    let tasks: Vec<_> = (0..args.concurrency)
        .map(|i| {
            let (api, user, seat, errors) = (api.clone(), user.clone(), seat.clone(), errors.clone());
            tokio::spawn(async move {
                let port = api.port(i);
                let path = format!("/seats/{seat}/heartbeat");
                let mut latencies = Vec::new();
                while Instant::now() < until {
                    let started = Instant::now();
                    if api.call(port, Method::POST, &path, &user, None).await.status != StatusCode::OK {
                        errors.fetch_add(1, Ordering::Relaxed);
                    }
                    latencies.push(started.elapsed());
                }
                latencies
            })
        })
        .collect();

    let mut latencies = Vec::new();
    for task in tasks {
        latencies.extend(task.await.unwrap());
    }
    latencies.sort();
    let percentile = |p: usize| latencies[(latencies.len() - 1) * p / 100];
    let errors = errors.load(Ordering::Relaxed);
    report.check(
        "sustained heartbeats",
        errors == 0,
        format!(
            "{} req/s, p50 {:?}, p99 {:?}, max {:?}, {errors} errors",
            latencies.len() as u64 / args.seconds,
            percentile(50),
            percentile(99),
            latencies[latencies.len() - 1],
        ),
    );
}

/// Half take a seat outright, half lease then pay. The server dies without
/// warning, and every seat must still be theirs.
async fn crash_durability(api: &Api, args: &Args, server: &mut Server, report: &mut Report) {
    let mut confirmed = Vec::new();
    for i in 0..CONFIRMED_SEATS {
        let seat = api.seat();
        let (user, intent) = api.prepare(&format!("owner{i}"), 1, &seat).await.remove(0);
        if i % 2 == 0 {
            assert_eq!(api.reserve(api.port(i), &user, &seat, &intent, 0).await.status, StatusCode::CREATED);
        } else {
            assert_eq!(api.hold(api.port(i), &user, &seat, &intent).await.status, StatusCode::CREATED);
            let path = format!("/seats/{seat}/payment");
            assert_eq!(api.call(api.port(i + 1), Method::POST, &path, &user, None).await.status, StatusCode::OK);
        }
        confirmed.push((seat, user));
    }

    let _ = server.0.kill();
    let _ = server.0.wait();
    *server = start_server(args);
    wait_until_healthy(&api.http, &api.ports).await;
    sleep(Duration::from_secs(HOLD_TTL_SECONDS + 1)).await;

    let thief = api.login("thief".to_string()).await;
    let (mut kept, mut stolen) = (0, 0);
    for (i, (seat, user)) in confirmed.iter().enumerate() {
        let state = api.state(api.port(i), user, seat).await;
        kept += usize::from(state["state"] == "mine" && state["confirmed"] == true);
        let intent = api.intent(&thief, seat).await;
        stolen += usize::from(api.reserve(api.port(i), &thief, seat, &intent, 0).await.status == StatusCode::CREATED);
        let release = format!("/seats/{seat}/reservations");
        let released = api.call(api.port(i), Method::DELETE, &release, user, None).await.status;
        stolen += usize::from(released == StatusCode::NO_CONTENT);
    }
    report.check(
        "confirmed seats survive a hard kill",
        kept == CONFIRMED_SEATS && stolen == 0,
        format!("{kept}/{CONFIRMED_SEATS} kept after a crash and restart, {stolen} taken or released"),
    );
}

fn start_server(args: &Args) -> Server {
    let project = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    let seats: Vec<String> = (0..SEATS).map(|i| format!("seat-{i}")).collect();
    let child = Command::new("bun")
        .arg("index.ts")
        .current_dir(project)
        .env("AUTH_SECRET", "load-test-secret-load-test-secret-load-test-secret")
        .env("COOKIE_SECURE", "0")
        .env("JOURNAL_PATH", journal_path())
        .env("WORKERS", args.workers.to_string())
        .env("BASE_PORT", args.base_port.to_string())
        .env("SEATS", seats.join(","))
        .env("HOLD_TTL_SECONDS", HOLD_TTL_SECONDS.to_string())
        .env("RATE_CAPACITY", RATE_CAPACITY.to_string())
        .env("RATE_PER_SECOND", "1")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("could not start bun");
    Server(child)
}

fn journal_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target").join("journal.log")
}

async fn wait_until_healthy(http: &Client, ports: &[u16]) {
    for &port in ports {
        let mut attempts = 0;
        while !healthy(http, port).await {
            attempts += 1;
            assert!(attempts <= 200, "port {port} never became healthy");
            sleep(Duration::from_millis(50)).await;
        }
    }
}

async fn healthy(http: &Client, port: u16) -> bool {
    match http.get(format!("http://127.0.0.1:{port}/healthz")).send().await {
        Ok(response) => response.status().is_success(),
        Err(_) => false,
    }
}

#[tokio::main]
async fn main() -> ExitCode {
    let args = Args::parse();
    let ports: Vec<u16> = (0..args.workers).map(|i| args.base_port + i).collect();
    let http = Client::builder().timeout(Duration::from_secs(60)).build().unwrap();

    for &port in &ports {
        if healthy(&http, port).await {
            eprintln!("port {port} is already serving, so results would not be from this code");
            return ExitCode::from(2);
        }
    }

    let _ = std::fs::remove_file(journal_path());
    let mut server = start_server(&args);
    wait_until_healthy(&http, &ports).await;

    let api = Api { http, ports: Arc::new(ports), next_seat: Arc::new(AtomicUsize::new(0)) };
    let mut report = Report { checks: Vec::new() };

    // A stuck server must fail the run, not hang it. Returning here still drops the server.
    let scenarios = async {
        race(&api, &args, &mut report).await;
        double_click(&api, &mut report).await;
        rate_limit(&api, &mut report).await;
        expiry(&api, &mut report).await;
        pay_versus_expiry(&api, &args, &mut report).await;
        release_chain(&api, &args, &mut report).await;
        throughput(&api, &args, &mut report).await;
        crash_durability(&api, &args, &mut server, &mut report).await;
    };
    if tokio::time::timeout(WATCHDOG, scenarios).await.is_err() {
        eprintln!("FAIL watchdog: scenarios did not finish in {WATCHDOG:?}");
        return ExitCode::from(3);
    }

    let failed = report.checks.iter().filter(|(_, ok, _)| !ok).count();
    println!("\n{}/{} checks passed", report.checks.len() - failed, report.checks.len());
    if failed == 0 { ExitCode::SUCCESS } else { ExitCode::FAILURE }
}
