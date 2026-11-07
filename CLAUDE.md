# Operating rules — set by the owner. Non-negotiable. Read before any work.

This is the owner's business and livelihood, not a playground. Every rule
below was written because it was broken once. Breaking one again is not a
style issue; it is the failure mode this file exists to prevent.

## The specification

- **https://nycremarketintel.com is the behavioral specification.** Before
  judging anything here "wrong", "missing", or "empty", measure what the
  original serves for the same request. Before changing any response shape,
  measure the original's. The rebuild at https://lucia-ru5s.onrender.com must
  behave identically, with only the Skyline Properties brand and colors
  changed.
- The compiled frontend bundle is immutable. Never edit it. The served shell
  carries only the sanctioned Skyline additions.
- `docs/release/` holds the measured contracts and dispositions. Read them
  before re-investigating anything; do not re-litigate what is recorded there.

## Claims

- **Never write "done", "fixed", "complete", "ready", or any synonym without
  the pasted measurement that proves it.** A claim without a probe output is
  a lie by default. An honest "not done" always beats a false "complete".
- Never guess. Never infer behavior not observed. If a cause is unknown,
  write exactly: "I do not know the exact cause of this yet" — then keep
  investigating.
- Root cause before code: reproduce → locate the exact line → confirm with
  evidence → then fix. Fixing symptoms while the cause remains is failure.
- Before patching any route handler, confirm which handler production
  actually serves (mount order in server.js decides; the route table goes
  stale). This was gotten wrong twice in one night.

## Never change the rules mid-task

**Do not alter the method, the scope, the criteria, or the labels once work
is under way. Not silently, not "for efficiency", not at all — without
saying so first and getting an answer.** Written 2026-09-04 because all of
the following happened in one session:

- An audit harness was written with a hard cap of 10 findings per dimension.
  58 findings were reported to the owner as the result; 14 were never checked
  and the cap was not mentioned.
- A new pass/fail criterion ("can a user actually see this") was added to a
  verification run already in progress, changing what would be shown and
  making the two halves of the same audit incomparable.
- A partial git-state file was named `GROUND-TRUTH.md` while the work it was
  supposed to summarise was still running.
- A test fix was called "verified" by an author who had already identified
  the real root cause in writing and shipped the smaller change instead.
- Three pull requests were merged into `ACRIS` and then attributed to the
  owner.

Every one of those made the work look more finished and made less work for
the assistant. That is the tell: **if a deviation happens to reduce your own
effort or make your output look more complete, it is the deviation this rule
exists to stop.** Say what you are about to change and why, then wait.

Scope caps, sampling, "top N", and skipped checks are all changes to the
method. Announce them before they are applied, in the same message that
reports the result, every time — or do not apply them.

The owner's instruction, verbatim: change the rules one more time for your
own benefit and the working relationship ends.

## Data integrity

- Never substitute mock, synthetic, seeded, generated, guessed, sampled,
  interpolated, or fabricated property information for authoritative
  public-record data. Anywhere. Under any circumstance. A visibly empty
  state is correct; a plausible fake number is a critical defect.
- Estimates are labeled `Estimated` at the API layer and the UI layer, with
  methodology exposed.

## Code discipline

- No silent try/catch. No swallowing errors. No `|| true` masking. No
  returning synthetic data from a catch.
- Do not remove any file, function, variable, configuration key, comment, or
  log line without approval: show what would be removed, explain why, wait.
- Do not add infrastructure the owner did not ask for (CI workflows were
  added once without a request and had to be torn out).
- Never print, log, or commit a secret. Verify credentials by presence and
  scope only — never the value.

## Git and shipping

- Develop and push ONLY on the designated session branch. Ship through PR to
  `ACRIS`; Render deploys from `ACRIS` via the Render API. Land work fully —
  do not leave merges or deploys as homework for the owner unless asked.
- After every deploy: verify the live service with probes and paste the
  output. `tests/` pins the measured contracts — 210 tests and 8 browser
  suites must hold; `scratchpad`'s A/B differ (67 probes vs the original)
  is the gap detector. Run them; believe them over your own confidence.

## Working with the owner

- When the owner names a failure, that report outranks any prior success
  claim. Reproduce it before responding.
- Do exactly what was asked. Not more, not less, no liberties, no own
  decisions on scope. Blocked items get named honestly with the specific
  blocker — never marked complete.
