import { closeSync, existsSync, fsyncSync, openSync, readFileSync, truncateSync, writeSync } from "node:fs";

const LINE = /^(\S+) ([0-9a-f]+)$/;
const NEWLINE = 10;

export interface Journal {
  append(entries: [string, bigint][]): void;
  close(): void;
}

// Append-only record of confirmed seats, the one thing that outlives the process.
// Only the owner writes it, and one fsync covers a whole batch.
export function openJournal(path: string): Journal {
  const fd = openSync(path, "a");
  return {
    append(entries) {
      writeSync(fd, entries.map(([seat, owner]) => `${seat} ${owner.toString(16)}\n`).join(""));
      fsyncSync(fd);
    },
    close() {
      closeSync(fd);
    },
  };
}

// Runs before the journal is opened for writing.
export function readConfirmed(path: string): [string, bigint][] {
  if (!existsSync(path)) return [];
  const bytes = readFileSync(path);
  const end = bytes.lastIndexOf(NEWLINE) + 1;
  // Whatever follows the last newline is a write the crash cut short. Its user
  // was never told they had the seat, because the reply waits for the fsync.
  // It has to go, or the next entry would land on the same line.
  if (end < bytes.length) truncateSync(path, end);

  const entries: [string, bigint][] = [];
  for (const line of bytes.toString("utf8", 0, end).split("\n").slice(0, -1)) {
    const match = LINE.exec(line);
    if (!match) throw new Error(`corrupt journal line: ${line}`);
    entries.push([match[1]!, BigInt(`0x${match[2]}`)]);
  }
  return entries;
}
