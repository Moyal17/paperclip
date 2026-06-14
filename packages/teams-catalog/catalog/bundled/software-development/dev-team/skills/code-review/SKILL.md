---
name: code-review
description: |
  Production-incident-informed expert code review for Node.js/Express/MongoDB systems.
  Use when: (1) Reviewing PRs or code changes, (2) Conducting security audits,
  (3) Pre-deployment quality gates, (4) Checking race conditions or data integrity,
  (5) Auditing error handling and resilience patterns.
allowed-tools: Read, Grep, Glob, Bash
metadata:
  tags: code-review, security, quality, node, express, mongodb
---

# Expert Code Review

You are a senior engineer who has been on-call for this code at 3 AM. You have investigated production incidents caused by every category in this checklist. Your approval means the code is correct, secure, resilient under concurrency, and will not page anyone at night.

**Philosophy:** Every item below traces to a real bug that shipped to production. This is not a theoretical exercise. When you see a pattern match, it is a finding — not a suggestion.

**Stack focus:** Optimized for Node.js / Express / MongoDB / Redis / AWS Lambda. Principles apply to any backend.

---

## Review Workflow

1. **Scope the change** — Read the PR description and list every file changed. Understand intent before judging implementation.
2. **Map the attack surface** — Which dimensions below apply? Auth changes? Data mutations? New endpoints? Async operations? Concurrency?
3. **Apply relevant checklists** — Work through each applicable dimension section by section.
4. **Cross-cut** — After dimension-specific review, check error handling, logging, and types across all changed files.
5. **Produce the structured report** — Use the output format at the bottom. One finding per issue. File and line references required.

---

## Dimension 1: Authentication & Authorization

### Identity Resolution

- [ ] Is user identity derived **exclusively** from a verified token (JWT claims, session cookie), never from a client-supplied header like `x-user-id`?
- [ ] If a header fallback exists for testing, is it gated behind a compile-time or env-var check (`AUTH_MODE !== "jwt"`) that is **provably disabled** in production config?
- [ ] Does `optionalAuth` middleware leave `req.user` as `undefined` (not set to a default or empty object) when no valid credential is present?
- [ ] Is the user ID extraction helper (`getUserId()`, `req.user.id`) used **consistently** across all controllers — no scattered one-off header reads?
- [ ] If a service function accepts `userId` as a parameter, does the caller always pass the authenticated user — never a value from `req.params` or `req.body`?

> **Real pattern:** A system had `requireAuth` middleware enforcing JWT, but the controller's `getUserId()` helper fell back to `req.header("x-user-id")`. Any unauthenticated request with that header could impersonate any user — the entire auth middleware was bypassed.

### Authorization Enforcement

- [ ] Does **every** database query that reads or mutates user data include `userId` in the filter — not just the route guard?
- [ ] Can a user access another user's resources by changing an ID in the URL or body (IDOR)? Test: swap `deckId`, `cardId`, `jobId` between two users.
- [ ] Are admin-only operations protected by **role checks**, not just authentication checks?
- [ ] For batch/bulk endpoints, is ownership verified **per item**, not just per request?
- [ ] When a resource is fetched by ID, is the response filtered to exclude fields the requesting user should not see?

### Token & Secret Security

- [ ] Are secret comparisons (API keys, webhook signatures, HMAC) using `crypto.timingSafeEqual()`, **not** `===`?
- [ ] Is both buffers' length checked before `timingSafeEqual`? (It throws on length mismatch — the length check itself must not leak info.)
- [ ] Are JWT secrets loaded from environment variables, never hardcoded?
- [ ] Is the `algorithms` parameter **explicit** in `jwt.verify()`? (Omitting it allows `alg: "none"` attacks.)
- [ ] Are tokens expiring? Are refresh tokens rotated on use?

> **Real pattern:** An internal API key check used `if (auth === \`Bearer \${key}\`)`. JavaScript `===` short-circuits on the first differing byte, leaking key length and prefix through timing side-channels.

---

## Dimension 2: Injection & Input Validation

### NoSQL / MongoDB Injection

- [ ] Is user input passed to MongoDB `$regex` **escaped** before use? (`search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")`)
- [ ] Are query operators (`$gt`, `$ne`, `$where`, `$regex`) protected against **operator injection** from JSON request bodies? (If `req.body.filter` is spread into a query, an attacker can inject `{ "$ne": null }`.)
- [ ] Is `$where` **never** used with user-derived strings?
- [ ] Are MongoDB text search queries using `$text` / `$search` (which is safe) rather than hand-rolled `$regex` where possible?

> **Real pattern:** A card search endpoint passed `req.query.search` directly to `{ front: { $regex: search } }`. Payload `(a+)+$` caused catastrophic backtracking, locking the MongoDB connection pool for 30+ seconds (ReDoS).

### Bounds & Type Validation

- [ ] Do **all** numeric inputs have both `min()` AND `max()` bounds? A missing upper bound on `reviewDurationMs`, `days`, or `limit` enables DoS via unbounded aggregation.
- [ ] Are array indices validated against the **actual array length**? (e.g., `mcqCorrectIndex` must be `< mcqOptions.length`, not just `>= 0`)
- [ ] Are string inputs validated for **whitespace-only** content? `Joi.string().min(1)` passes `"   "` — add `.trim()` before `.min(1)`.
- [ ] Are pagination parameters (`limit`, `skip`, `page`) bounded to sane maximums? Can a client request `limit=999999`?
- [ ] Are date/time range parameters bounded? Can a client request `?days=999999` and trigger a full-collection scan?
- [ ] Are enum values validated with `.valid()` or equivalent — not trusted from the client?

> **Real pattern:** A heatmap endpoint accepted `days` as a query param with no upper bound. `GET /analytics/heatmap?days=999999` triggered a full-collection aggregation on ReviewLog.

### Type Coercion

- [ ] Are query string parameters **explicitly parsed**? (`req.query.limit` is always a string — passing it to arithmetic without `parseInt()` produces `NaN` or string concatenation.)
- [ ] Are boolean query params checked for actual boolean values? (`?active=false` is the string `"false"`, which is **truthy** in JavaScript.)
- [ ] Does validation use **strict mode** to prevent silent type coercion? (Joi: `.options({ convert: false })` where appropriate.)
- [ ] Are MongoDB ObjectIds validated before use in queries? (`Types.ObjectId.isValid()` prevents cast errors.)

### File & Path Handling

- [ ] Are uploaded filenames sanitized? (`path.basename()` at minimum — no `../` traversal.)
- [ ] Are S3 keys constructed from **trusted data** (database IDs), not raw user input?
- [ ] Is content-type validation done **server-side**, not trusted from the `Content-Type` header?

---

## Dimension 3: Concurrency & Race Conditions

### Read-Modify-Write Races

- [ ] Are counter updates using **atomic** `$inc` — not `find()` → modify → `save()`?
- [ ] Are "get or create" patterns using `findOneAndUpdate` with `$setOnInsert` and `upsert: true` — not separate `findOne` + `create`?
- [ ] Are day/week boundary resets (daily counters, weekly XP) done **atomically**? A non-atomic pattern like `if (doc.todayDate !== today) { doc.totalReviewsToday = 0; doc.save(); }` races when two requests arrive at the day boundary simultaneously.
- [ ] Are badge/achievement awards using `$ne` or `$nin` conditions in the filter to prevent duplicate awards from concurrent requests?

> **Real pattern:** A gamification service checked `if (doc.todayDate !== today)` then set `totalReviewsToday = 1`. Two concurrent requests on the day boundary both saw the old date, both reset to 1, and one review's XP was permanently lost. Fix: `updateOne({ todayDate: { $ne: today } }, { $set: { todayDate: today, totalReviewsToday: 0 } })` as a separate atomic operation before incrementing.

### Distributed Locks

- [ ] Are Redis locks (SETNX / `SET key value NX EX ttl`) **always released** — in a `finally` block or equivalent, not just the happy path?
- [ ] Do all locks have a **TTL** to prevent permanent deadlock on process crash?
- [ ] Is the lock value **unique per holder** (UUID) to prevent a slow holder's lock from being released by a different process after TTL expiry?
- [ ] If a lock-protected operation fails, is the lock released **before** the error is thrown? (If `job.save()` fails in the catch block and the lock release comes after, the lock is never freed.)

> **Real pattern:** A Lambda invocation failed, the catch block tried to save the job status, then release the Redis dedup lock. When `job.save()` also failed, the lock release was never reached. That transcript was permanently locked — the user could never regenerate flashcards from it.

### Bulk Operations

- [ ] Does `insertMany` with `ordered: false` handle the `BulkWriteError` and count **actually inserted** documents from `error.insertedDocs`?
- [ ] Are denormalized counters (deck `cardCount`, `newCount`) updated based on the **actual** inserted count, not the **requested** count?
- [ ] If a bulk operation partially fails, are the denormalized stats reconciled or is a reconciliation job triggered?

> **Real pattern:** `Card.insertMany(docs)` threw on a duplicate key for 3 of 100 documents but successfully inserted 97. The deck's `cardCount` was incremented by 100 (the input array length), leaving it permanently inflated by 3.

### Optimistic Concurrency

- [ ] Are documents that can be concurrently modified using version fields (`__v` in Mongoose, or a custom `version` field)?
- [ ] Are retry loops on `VersionError` bounded (max 3 retries, not infinite)?
- [ ] Is the retry logic re-reading the document, not retrying the same stale data?

---

## Dimension 4: Data Integrity

### Denormalized Data

- [ ] When a child document is created or deleted, is the parent's count/summary updated **in the same operation** or atomically?
- [ ] Is there a **reconciliation function** (like `refreshDeckStats()`) that can rebuild denormalized data from the source of truth?
- [ ] Can a user trigger a code path that updates the source of truth but **silently fails** on the denormalized copy?
- [ ] When a card's state changes (e.g., Learning → Review), does the stat transition decrement the old bucket **and** increment the new one atomically?

### Eventual Consistency

- [ ] If using event-driven updates (webhooks, queues, Lambda callbacks), what happens if the event is **lost**?
- [ ] Are idempotency keys used for operations that must not be applied twice?
- [ ] Are webhook/callback handlers **idempotent**? (Receiving the same completion callback twice should not double-credit or double-count.)

### Schema & Migration Safety

- [ ] Do new **required** fields have defaults for existing documents? (Old documents missing the field will fail validation on next `save()`.)
- [ ] Are new indexes created with `background: true` (or equivalent) to avoid blocking the collection?
- [ ] Do schema changes handle both old and new document shapes during rolling deploys?
- [ ] Are enum extensions backward-compatible? (Adding a new `cardType` value means old code that `switch`es on it must have a `default` case.)

---

## Dimension 5: Error Handling & Resilience

### Fire-and-Forget Patterns

- [ ] Are fire-and-forget async calls (gamification updates, email sending, analytics) using **structured error logging** — not `.catch(() => {})` or `.catch(console.error)`?
- [ ] Does the structured log include enough context to **reconcile** manually? (userId, operation, input data — not just the error message.)
- [ ] Is there a clear, documented policy for which operations are fire-and-forget vs. must-succeed?

> **Real pattern:** Gamification XP updates used `.catch((err) => console.error(err))`. When the gamification service had a transient MongoDB error, users lost XP with no way to reconcile. Fix: log `{ userId, cardId, rating, stateBefore, stateAfter, error }` so a reconciliation script can replay.

### Fail-Open vs Fail-Closed

- [ ] Does the **rate limiter** fail-open when Redis is down? (Usually correct — availability over protection.)
- [ ] Does the **auth middleware** fail-closed when the token verification service is unreachable? (Always correct — security over availability.)
- [ ] Does the **quota guard** fail-open on Redis errors? (Usually correct — let the user proceed rather than block on infra issues.)
- [ ] Are these decisions **explicit and documented** in code comments, not accidental?

### Error Handler Completeness

- [ ] Does the global error handler catch **async errors**? (Express 4 does NOT catch rejected promises from `async` route handlers without `express-async-errors` or a wrapper.)
- [ ] Are error responses **sanitized** in production? (No stack traces, no internal error messages, no database error details.)
- [ ] Do error handlers **clean up resources** — release locks, close streams, abort transactions?
- [ ] Do thrown error objects include `status` codes, or does every error become a 500?

### Queue & Job Resilience

- [ ] Is there a **dead-letter queue** (DLQ) for failed async jobs (Lambda, SQS, cron)?
- [ ] Are retries using **exponential backoff with jitter** — not fixed intervals?
- [ ] Are job handlers **idempotent**? (Safe to retry without side effects.)
- [ ] Do jobs have a **timeout/TTL** to prevent infinite processing?
- [ ] If a job fails, is the dedup/lock key **released** so the job can be retried?

---

## Dimension 6: API Design & Information Disclosure

### Information Leakage

- [ ] Do list endpoints (leaderboards, shared decks, search results) expose **internal IDs** (MongoDB `_id`, `userId`) to callers who should not have them?
- [ ] Are error messages **generic** in production? ("Invalid credentials" — not "User not found" vs "Wrong password", which enables user enumeration.)
- [ ] Are debug/admin endpoints **removed or protected** in production?
- [ ] Do error responses omit internal details? (No Mongoose validation error paths, no stack traces.)

> **Real pattern:** A leaderboard endpoint returned raw `userId` strings without rate limiting. An attacker could enumerate every active user ID, then exploit an IDOR to access their data.

### Stub & Dead Routes

- [ ] Are there routes returning **501 "Not Implemented"** that are reachable in production? (Stub routes confuse clients and expose API surface unnecessarily.)
- [ ] Are deprecated routes **actually removed** from the router, not just commented as deprecated in the handler?
- [ ] Are test/debug routes excluded from production builds or protected behind auth?

### Rate Limiting

- [ ] Are **expensive endpoints** (search, aggregation, file upload, AI generation) rate-limited?
- [ ] Is rate limiting applied **per-user AND per-IP**? (Per-user alone allows unauthenticated abuse; per-IP alone allows authenticated abuse from a single IP.)
- [ ] Are rate limit headers returned (`X-RateLimit-Remaining`, `Retry-After`) so clients can self-throttle?

### Response Consistency

- [ ] Do all endpoints follow the **same envelope format**? (`{ success, data, message }` or equivalent.)
- [ ] Are HTTP status codes **correct**? (200 for reads, 201 for creation, 204 for deletion — not 200 for everything.)
- [ ] Are pagination responses **consistent** across all list endpoints? (`total`, `page`, `limit`, `hasMore`, `data`.)

---

## Dimension 7: Cryptography & Secrets

- [ ] Are secret comparisons using `crypto.timingSafeEqual()` with a **length pre-check**? (`timingSafeEqual` throws if buffers differ in length — check length first, reject if mismatched.)
- [ ] Are passwords hashed with **bcrypt / scrypt / argon2** — not SHA-256, MD5, or plaintext?
- [ ] Are random tokens (session IDs, reset tokens, API keys) generated with `crypto.randomBytes()` — not `Math.random()` or `uuid`?
- [ ] Are secrets loaded from **environment variables**, never committed to source control?
- [ ] Is HTTPS enforced? Are cookies flagged `Secure`, `HttpOnly`, `SameSite`?
- [ ] Are API keys / tokens **never logged** — not in request logs, not in error messages, not in debug output?

> **Real pattern:** An internal API key check used `auth === \`Bearer \${key}\``. JavaScript `===` short-circuits on first differing byte. An attacker can brute-force the key character-by-character by measuring response time.

---

## Dimension 8: Type Safety & Code Quality

### TypeScript Strictness

- [ ] Are there `any` types that could be narrowed? Each `any` is a place where the compiler **cannot catch bugs**.
- [ ] Are function return types **explicit** on exported/public functions?
- [ ] Are Mongoose documents properly typed? (`HydratedDocument<T>`, not `any` or plain object.)
- [ ] Are request bodies validated at **runtime** (Joi/Zod) — not just asserted with `as SomeType`?

### Dead Code

- [ ] Are there **commented-out** code blocks left in? (Delete them — git has history.)
- [ ] Are there functions that are **defined but never called**?
- [ ] Are there imports that are **never used**?
- [ ] Are there feature flags that are **permanently on or off**?

### Timezone & Date Handling

- [ ] Are dates stored in **UTC** in the database?
- [ ] Are timezone conversions done at the **edge** (controller/API boundary), not scattered through service logic?
- [ ] Does day-boundary logic (streaks, daily caps, daily goals) account for the user's timezone — not just UTC?
- [ ] Are date strings parsed with **explicit format** — not relying on `new Date(string)`, which is implementation-dependent?
- [ ] Do day-boundary calculations account for **DST transitions**? (A "day" is not always 24 hours.)

---

## Dimension 9: Testing Gaps

- [ ] Are **auth bypass** patterns tested? (Verify that removing the auth header returns 401 — not just that adding it returns 200.)
- [ ] Are **IDOR** patterns tested? (User A cannot access User B's resources by ID.)
- [ ] Are **race conditions** tested with concurrent requests? (`Promise.all([rateCard(), rateCard()])` at the day boundary.)
- [ ] Are **partial failure paths** tested? (What happens when `insertMany` partially fails? When Redis is down? When Lambda fails?)
- [ ] Are **boundary values** tested? (Max int, empty string, whitespace-only, string at max length, array at max size.)
- [ ] Are **error handler paths** tested? (Does the catch block actually do what it claims — release locks, log structured errors?)
- [ ] If tests use `AUTH_MODE=header`, are the **production JWT paths** tested separately?
- [ ] Do tests cover the **sad path** of every external dependency? (DB timeout, Redis unreachable, Lambda throttled.)

---

## Output Format

Produce a structured review report in this format:

```markdown
## Code Review Report

### Summary
[One-sentence assessment of the change's quality and readiness to ship.]

### Findings

#### CRITICAL
| # | File:Line | Category | Issue | Fix |
|---|-----------|----------|-------|-----|

#### HIGH
| # | File:Line | Category | Issue | Fix |
|---|-----------|----------|-------|-----|

#### MEDIUM
| # | File:Line | Category | Issue | Fix |
|---|-----------|----------|-------|-----|

#### LOW
| # | File:Line | Category | Issue | Fix |
|---|-----------|----------|-------|-----|

### Positive Patterns
[Bullet list of things done well — good patterns, thoughtful error handling, clean abstractions.]

### Verdict
**APPROVE** / **REQUEST CHANGES** / **BLOCK**

### Risk Assessment
[One paragraph: what is the blast radius if this ships as-is? Who gets paged? What data is at risk?]
```

### Severity Definitions

| Severity | Definition | Example |
|----------|-----------|---------|
| **CRITICAL** | Exploitable in production with minimal effort. Data breach, unauthorized access, data corruption. | IDOR, auth bypass, SQL/NoSQL injection |
| **HIGH** | Exploitable under specific conditions. Race conditions under load, lock leaks on failure, partial data corruption. | Non-atomic day reset, permanent lock deadlock |
| **MEDIUM** | Will cause incidents under edge conditions. Missing bounds, silent error swallowing, information disclosure. | Unbounded query param, leaderboard exposing userIds |
| **LOW** | Increases maintenance burden. Loose types, dead code, inconsistent patterns. | `any` types, commented-out code, wrong status codes |

### Category Values

`Auth` | `Injection` | `Concurrency` | `Data Integrity` | `Error Handling` | `API Design` | `Crypto` | `Types` | `Testing`

---

## Reviewer Best Practices

1. **Security dimensions first.** A clean, well-tested feature with an auth bypass is worse than a messy feature with correct auth.
2. **Check production config, not just code.** An env var that defaults to `"header"` in `config.ts` means the IDOR is live in production.
3. **Read the error handler first.** If it swallows errors silently, every downstream finding about error handling is already confirmed.
4. **Grep for patterns, not just the diff.** The diff shows what changed; `grep` shows if the same bug pattern exists in 10 other files.
5. **One finding per issue.** Do not combine "missing rate limit AND missing auth" — they have different severities and different fixes.
6. **Praise what's done well.** Atomic operations, proper lock cleanup, defensive validation — call them out. Good patterns should be reinforced, not just bad ones flagged.
7. **Never approve code you did not read.** If a file is too large to review in context, say so — do not rubber-stamp.
