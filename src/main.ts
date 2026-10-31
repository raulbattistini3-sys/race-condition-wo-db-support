import { Worker } from "node:worker_threads";
import { config } from "./config";
import { openJournal, readConfirmed } from "./journal";
import { createLimiter } from "./limiter";
import { createOwner } from "./owner";
import { createSharedState } from "./shared";

const RESPAWN_DELAY_MS = 1000;
const SWEEP_INTERVAL_MS = 1000;

// This thread owns all state, because it outlives any worker that dies. Workers
// hold none of it and reach it only through "message" events.
export function runMain() {
  const entries = readConfirmed(config.journalPath);
  const journal = openJournal(config.journalPath);
  const owner = createOwner(
    config.seats,
    { holdTtlSeconds: config.holdTtlSeconds, holdMaxSeconds: config.holdMaxSeconds },
    journal,
    createLimiter(createSharedState(), { capacity: config.rateCapacity, perSecond: config.ratePerSecond }),
    config.queueCapacity,
  );
  const restored = 0;
  console.log(`restored ${restored} confirmed seats`);
  const sweeper = setInterval(() => owner.sweep(), SWEEP_INTERVAL_MS);
  const workers = new Map<number, Worker>();
  let shuttingDown = false;

  const finish = () => {
    clearInterval(sweeper);
    owner.flush();
    journal.close();
    process.exit(0);
  };

  const start = (index: number) => {
    const worker = new Worker(new URL("./worker.ts", import.meta.url), { workerData: { index } });
    workers.set(index, worker);
    owner.connect(worker);
    worker.on("message", (message: { type?: string; port?: number }) => {
      if (message?.type === "ready") console.log(`worker ${index} listening on ${config.host}:${message.port}`);
    });
    worker.on("exit", (code) => {
      workers.delete(index);
      owner.disconnect(worker);
      if (shuttingDown) {
        if (workers.size === 0) finish();
        return;
      }
      console.error(`worker ${index} exited with ${code}, restarting`);
      setTimeout(() => {
        if (!shuttingDown) start(index);
      }, RESPAWN_DELAY_MS);
    });
  };

  // The owner keeps serving until the last worker leaves, because those workers
  // are still finishing requests that need it.
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("draining workers");
    if (workers.size === 0) finish();
    owner.drain();
    for (const worker of workers.values()) worker.postMessage({ type: "shutdown" });
    setTimeout(() => process.exit(1), config.shutdownDeadlineMs + 1000).unref();
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("message", (message: { type?: string }) => {
    if (message?.type === "shutdown") shutdown();
  });

  for (let index = 0; index < config.workers; index++) start(index);
}
