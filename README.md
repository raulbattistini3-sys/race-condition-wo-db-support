# README and description review: race-condition-wo-db-support

Oct 31, 2026 · @Raul Battistini

The description is close but undersells the project, and the README needs a cleanup pass before anyone sees it. The code itself is solid and matches what the README intends to say.

## The README is visibly broken

It looks pasted from a terminal: lines are hard-wrapped mid-word and chunks of text are missing. A reviewer notices this before reading any code.

| Problem | Examples |
| --- | --- |
| Missing text | "and coom the journal at boot", "requests join oo completion", `{ "namse the session cookie`, "bind to `127.0.0.1` and speroxy in front", "It adt, and so does startup replay time", "Take the s", "Extend your l", "Lifetime of an i", "delete `confi` |
| Words split across lines | "a / sks", "messa / ge", "hand / lers", "waite / r", "pe / rmanent" |
| `bun init` boilerplate mixed in | "To install dependencies:", "To run:", "This project was created using `bun init`…" inside your own paragraphs |
| Unclosed code fences | Two `bash` blocks never close, so the bold seat rule and the "How it works" heading render as code |
| Broken tables | The "journal is corrupt" row has no "what happens" cell; the `403` row stops at "a seat"; `QUEUE_CAPACITY` purpose is cut off |
| Unfinished last bullet | "solve this issue with little" just ends |
| Name mismatch | H1 is `request-simul-access-cluster`, repo is `race-condition-wo-db-support` |

## Alignment with the code

What the README claims holds up in the code:

- `owner.ts` is a single writer draining a bounded ring buffer (`fifo.ts`).
- Replies wait in an outbox until one `fsyncSync` covers the batch, and a failed fsync exits before anyone is told anything.
- The 503-on-full queue, worker respawn and torn-line truncation all match.

Two things to fix:

- **`shared.ts` creates `SharedArrayBuffer`s that never leave the owner thread**, as its own comment says. A reviewer who reads "no memory shared between threads" and then sees `SharedArrayBuffer` will think it's a contradiction. Use a plain `ArrayBuffer` or `BigUint64Array`.
- **The design is the single-owner approach, not CAS.** That's a legitimate choice, but the description should say what it is, not what it avoids.
  
IMG showcasing loadtests: https://imgur.com/a/YqApT51
