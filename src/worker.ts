import { parentPort, workerData } from "node:worker_threads";
import { createApp, type AppState } from "./app";
import { config } from "./config";
import { createSeatClient } from "./seat-client";

const { index } = workerData as { index: number };

const state: AppState = { draining: false, inFlight: 0 };
const seats = createSeatClient(config.seats, parentPort!);

const app = createApp({
  seats,
  secret: config.authSecret,
  intentTtlSeconds: config.intentTtlSeconds,
  maxWaitMs: config.maxWaitMs,
  session: { idleSeconds: config.sessionIdleSeconds, maxSeconds: config.sessionMaxSeconds },
  cookieSecure: config.cookieSecure,
  state,
  debugDelayMs: config.debugDelayMs,
  debugCrash: config.debugCrash,
});

const port = config.basePort + index;
const server = Bun.serve({ hostname: config.host, port, fetch: app.fetch });
parentPort?.postMessage({ type: "ready", port });

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  state.draining = true;
  setTimeout(() => process.exit(1), config.shutdownDeadlineMs).unref();

  await Bun.sleep(config.drainGraceMs);
  const stopped = server.stop();
  while (state.inFlight > 0) await Bun.sleep(25);
  await stopped;

  seats.close();
  process.exit(0);
}

parentPort?.on("message", (message: { type?: string }) => {
  if (message?.type === "shutdown") void shutdown();
});
