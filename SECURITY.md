# Security Policy

Peak-Abu takes security seriously. This document outlines our security posture, known limitations, and how to report vulnerabilities. Where something is still open rather than done, it's listed as open — a security doc that only lists finished work isn't a useful one.

---

## Reporting Security Vulnerabilities

**Do not open a public GitHub issue for security vulnerabilities.**

Instead, email: **greencompassgames@gmail.com** with:
- Vulnerability description
- Steps to reproduce
- Potential impact
- Your name / affiliation (optional but appreciated)

We will:
1. Acknowledge receipt as soon as possible
2. Investigate and confirm the issue
3. Develop and test a fix
4. Release a patched version

---

## Security Architecture

### Input Validation
- Server-side sanitization for usernames and session codes; client-side validation is UX only
- Upload extension whitelist (`.mp4`/`.json`), 500MB size cap, filename sanitization, path traversal protection with post-upload path re-verification
- Upload content-type verification via real ISO-BMFF box signature checks — not just the file extension. Files that fail are rejected and deleted, with the rejection logged.
- Upload metadata JSON is structurally validated (real object, required `version` field, sane timestamp range) before being trusted
- 100KB minimum video-size floor catches header-only/empty file stubs that pass the signature check but contain no real frames
- JSON request bodies capped at 1MB
- Password reset input length-bounded (8–128 chars) server-side, independent of client-side checks
- XSS mitigated via Content Security Policy headers (Helmet.js) plus explicit escaping on rendered clip metadata

### Authentication & Sessions
- Full account system (`/auth/register`, `/auth/login`, `/auth/me`) — bcrypt (12 rounds) + JWT (7-day expiry)
- Timing-safe login: a dummy hash comparison runs even for unknown usernames, so login timing doesn't reveal whether an account exists
- `JWT_SECRET` is required via environment variable and the server fails fast at boot if it's unset — no silent fallback to a weak default
- Single-login-per-account enforcement via a `tokenVersion` field: a new login invalidates prior tokens. Known accepted limitation: an already-connected Socket.IO session only re-checks `tokenVersion` on reconnect, so a superseded live socket can stay open until its next disconnect
- On the desktop client, the auth token is encrypted at rest via Electron's `safeStorage` (OS-backed: DPAPI on Windows, Keychain on macOS, libsecret on Linux) — not plaintext, not browser `localStorage`
- The public web player (viewing a shared session by code) requires no login at all, by design. Account-gated actions — uploads, exports, AI Reel, admin routes — go through JWT bearer tokens verified by middleware on both HTTP requests and the Socket.IO handshake
- **Discord OAuth account linking:** a short-lived, signed `state` value ties the OAuth flow to the already-authenticated Peak-Abu account; a Discord account can only be linked to one Peak-Abu account
- **Discord-based password recovery (no email collection):** uses a separate state map from the linking flow, so a link-state token can never be replayed as a recovery token or vice versa. An unlinked or non-matching Discord account gets a generic "no linked account" response — no username enumeration. Reset tokens are 32 random bytes, single-use, 15-minute expiry, in-memory only. A successful reset bumps `tokenVersion`, ending all existing sessions on that account
- Placeholder secrets have been caught and rotated in the past (`JWT_SECRET` and `ADMIN_SECRET` were briefly literal placeholder strings during early setup); `.env` is confirmed untracked and gitignored

### Authorization & Access Control
- Session creation, joins, and uploads all gated behind authentication
- Per-tier authorization (`requireTier`) enforced independently on the download route, the AI Reel route, and the composite-export route — a user can't reach a feature their tier doesn't include by hitting the endpoint directly
- Upload endpoint verifies the uploading username is actually a member of the target session
- Duplicate-username and multi-session-join prevention
- Session closed/open state persisted to SQLite (not an in-memory flag that resets on restart)
- Sessions are host-presence-locked: once the host leaves, no new joins are accepted, though the session remains viewable by code until it expires
- A configurable cap limits how many Free-tier members can occupy a single paid host's session
- Host-only moderation: hosts can kick or ban a member from an active session
- Sessions auto-close if the host goes inactive — two separate timeouts depending on whether the host is mid-recording (longer grace period) or just connected and idle (shorter one) — so an abandoned session doesn't sit open indefinitely
- Admin-only routes are gated by a timing-safe comparison against a dedicated admin secret, independent of any user account

### Secure Architecture
- Helmet.js applied globally (CSP, X-Frame-Options, HSTS, and related headers)
- A runtime-toggleable kill switch can pause new session creation and new registrations without a deploy, admin-gated and persisted so it survives a restart; it does not affect existing sessions or already-logged-in users
- Live, server-written data files (redemption codes, runtime feature flags, the PM2 process config) are gitignored — they were previously tracked in git, which meant every write caused deployment friction and, more importantly, meant that data was technically exposed in repo history. Fixed by untracking; the files remain on disk
- The password-reset flow is served as static pages, reusing the existing static-file middleware rather than adding new routes or new auth-bypass surface

### Data Protection
- HTTPS enforced end-to-end (nginx + Certbot)
- Sensitive fields (JWTs, password hashes, OAuth tokens) are never written to logs
- Clips are stored in Cloudflare R2, encrypted in transit via HTTPS
- Discord recovery collects nothing beyond the already-consented OAuth `identify` scope — no email, no phone number, consistent with the product's broader no-PII-collection stance
- Local clip cache on a user's own PC remains their own responsibility

### Secrets Management
- `.env` holds `JWT_SECRET`, `ADMIN_SECRET`, R2 credentials, and (optionally) Discord/Anthropic keys — never committed
- Secrets are managed via environment variables through PM2's `ecosystem.config.js`, which is itself gitignored
- No hardcoded API keys or credentials in source code

### Dependency & Supply Chain Security
- Security-sensitive dependencies (`@aws-sdk/client-s3`, `better-sqlite3`, `bcrypt`, `jsonwebtoken`) are exact-pinned rather than range-pinned, to avoid an unreviewed minor/patch bump changing behavior underneath a security-relevant library
- Dependabot is confirmed active on both `/server` and `/client` as separate ecosystems, weekly schedule
- `npm audit` run as part of the release process

### Logging & Monitoring
- Structured JSON logging with automatic redaction of sensitive fields
- PM2 log rotation configured, so logs don't fill the disk and stale crash-loop logs get flushed periodically
- Abuse-pattern monitoring beyond simple bandwidth counting: registration bursts, session-creation bursts, and upload-volume bursts are all tracked per key (per-IP or per-account, depending on the event) with configurable thresholds
- A separate bandwidth alert flags any single account pushing more than 500GB in a calendar month, so outliers get caught before they skew cost projections
- Discord recovery failures are logged with error detail, but the recovery code/token itself is never logged
- **Known gap — application crash and error reporting does not exist yet.** There's no equivalent of Sentry or Crashpad, and no top-level `uncaughtException`/`unhandledRejection` handling in either the client or server process. This means an unexpected crash currently produces no automatic signal beyond whatever a person happens to notice. This is the most significant near-term item on the security/reliability list.

### API & Network
- REST endpoints require a valid JWT; Socket.IO connections are authenticated during the handshake
- Rate limiting is live, not just planned: a shared `createRateLimiter()` factory backs global HTTP/WebSocket limits plus tighter per-route limits on uploads, comments, joins, and session lookups; separate limiters exist for per-IP WebSocket connections, per-account redemption-code attempts, and per-IP registrations
- **Known gap — `/auth/reset-password` has no dedicated rate limiter**, unlike the other sensitive auth routes. Actual exploitability is low (the reset token is 32 random bytes and effectively unguessable), but it's an inconsistency with the pattern used everywhere else and is cheap to close
- CORS restricts browser requests to the `peakabu.app` origin
- Admin routes are gated by secret comparison rather than network-level (IP/VPN) restriction — worth noting since that's a different control than "restricted to localhost," even though the practical effect (only someone with the secret can call them) is similar

---

## Known Limitations & Trade-offs

### Electron Client (Windows Only)
- **Reverse engineering risk:** Electron apps ship as ASAR archives, which can be extracted; the compiled JS and bundled assets are readable.
  - **Mitigation:** all security-relevant logic (auth, access checks, tier gating) runs server-side. The client is trusted only for UI and local capture, never for authorization decisions.
  - **Why Electron:** it's the practical way to support multiple capture engines (DDagrab, GDI, OBS VirtualCam fallback) on Windows without requiring users to compile native bindings themselves.

### Socket.IO Persistence
- **Denial-of-service risk:** many concurrent connections could exhaust droplet memory.
  - **Mitigation:** per-IP WebSocket connection caps and per-user connection limits are enforced; stale connections are cleaned up automatically.
  - **Not yet done:** fail2ban-style IP-level blocking isn't integrated. The current rate-limiting and anomaly-detection layers cover a meaningful part of the same threat, but it's a different mechanism than what was originally scoped here.

### SQLite Session/User Store
- Session and user data live in SQLite via `better-sqlite3`, accessed through prepared statements — a real change from the earlier flat-JSON-file design, and one that removes the concurrent-write race risk that design carried.
  - **Current scale:** fine for the droplet's current concurrency profile.
  - **Known limitation:** single-droplet, no read replica or failover. A Redis-backed session layer with a job queue for FFmpeg work is designed but not yet built — worth revisiting if concurrent load grows past what a single SQLite file comfortably handles.

### FFmpeg Subprocess
- **Code injection risk:** if user-supplied clip names or metadata weren't sanitized before reaching FFmpeg, they could inject shell behavior.
  - **Status: mitigated.** All FFmpeg arguments are passed as an array via Node's `child_process.spawn()`, never as an interpolated shell string. No shell interpolation, no injection surface here.

### Droplet Access
- **SSH key management:** the droplet is accessible only via SSH key, not password auth.
  - **Mitigation:** keys stored securely; rotate if access needs to change.
  - **Not yet done:** a dedicated non-root deployment user with restricted sudo hasn't been set up.

### Cloudflare R2
- **Bucket policy:** the bucket is public-for-reading, because clips need to be playable without requiring login.
  - **Mitigation:** clip URLs are gated behind long, random session codes — brute-forcing one is computationally infeasible, and server-side checks prevent non-members from being handed a specific clip URL they shouldn't have.
  - **Accepted risk:** someone who already has a clip's direct URL can view it without being a session member. This is intentional — clips are shareable by design — but it means URL possession, not membership, is the actual access boundary once a link exists.
  - **Side benefit:** R2 has no egress fees, which meaningfully changes the cost math on a bandwidth-heavy product compared to the previous DigitalOcean Spaces setup.

### Browser Security (Web Player)
- Strict CSP prevents inline scripts and unexpected external resource loading
- CORS restricts the player to `peakabu.app`
- Clip metadata (titles, notes, comments) is validated and escaped before rendering

---

## Threat Model

### In Scope (We Protect Against)
- ✅ Unauthorized users viewing or downloading clips they're not entitled to
- ✅ Session hijacking via a stolen JWT
- ✅ SQL injection — SQLite queries go through `better-sqlite3` prepared statements, not string concatenation
- ✅ Cross-site scripting via malicious clip names or metadata
- ✅ Weak-password attacks (bcrypt + length enforcement)
- ✅ Man-in-the-middle (HTTPS everywhere)
- ✅ Accidental data exposure via logs (sensitive fields never logged)
- ✅ Abuse bursts — rapid-fire registrations, session creation, or uploads from a single source

### Out of Scope (We Accept Risk)
- ❌ Someone reverse-engineering the Electron binary and extracting FFmpeg filter chains
- ❌ A breach at DigitalOcean or Cloudflare (responsibility of the cloud provider)
- ❌ A user losing their password manager and forgetting their Peak-Abu password (Discord recovery covers the common case; there's no fallback beyond that)
- ❌ A user's own PC being compromised, exposing their local clip cache
- ❌ A nation-state-level adversary attempting to crack bcrypt hashes directly (bcrypt is industry standard; this is accepted as out of scope for a product at this stage)
- ❌ Blind spots between crash-reporting being absent and a person noticing something broke — see the disclosed gap above. This is being treated as a near-term priority to close, not a permanently accepted risk.

---

## Security Checklist for Future Releases

### v0.2 Hardening
- [x] Structured JSON logging with sensitive-field redaction
- [x] Rate limiting on auth endpoints (with one known gap — see `/auth/reset-password` above)
- [ ] fail2ban-style IP blocking — anomaly detection covers part of this need, but the specific mechanism isn't in place
- [ ] Audit log for clip access (who watched what, when)
- [ ] Refresh-token rotation (separate short-/long-lived tokens) — `tokenVersion` gives single-login-per-account invalidation today, which is related but not the same thing
- [ ] Two-factor authentication for paid tiers — deprioritized, not urgent pre-launch
- [ ] Formal OWASP Top 10 testing pass (automated + manual)

### Pre-1.0 (Before Public Marketing)
- [ ] Penetration testing by a third party
- [ ] GDPR compliance audit (data deletion flow, privacy policy) — starting position is reasonable given minimal PII collection, but this hasn't been formally audited
- [ ] `security.txt` file for responsible disclosure
- [x] Automated dependency scanning — Dependabot confirmed live, weekly, on both ecosystems
- [ ] Confirm droplet sizing is adequate under real backer-scale concurrent load
- [x] Move off flat-file session/user storage — done via SQLite; a distributed (Redis-backed) layer remains a separate, deferred scaling step if load warrants it
- [ ] API versioning for graceful endpoint deprecation
- [ ] **Application crash reporting / error observability** — see disclosed gap above; this is the top item on this list

### Post-Launch Maintenance
- [ ] Recurring `npm audit` on a fixed cadence (Dependabot provides continuous partial coverage in the meantime)
- [ ] Security review on a fixed cadence — informal reviews have happened repeatedly (most recently 8/24/26), but no fixed quarterly schedule has been declared
- [ ] Written incident response playbook — still doesn't exist as a document
- [ ] Confirmed, tested backup process for the R2 media bucket

---

## Compliance & Standards

Peak-Abu is designed with OWASP Top 10 and Microsoft SDL categories in mind. Marked honestly — partial coverage is marked as partial, not rounded up:

- **A01:2021 – Broken Access Control:** ✅ Server-side authorization on every request; role granularity is currently host/member rather than a fuller creator/participant/viewer model
- **A02:2021 – Cryptographic Failures:** ✅ HTTPS everywhere, secrets in environment variables, client token encrypted at rest via OS-backed storage
- **A03:2021 – Injection:** ✅ Input validation, FFmpeg args via `spawn()` (no shell), SQLite via prepared statements
- **A04:2021 – Insecure Design:** ✅ Active, recurring threat-modeling sessions (security tracker updated multiple times through the beta)
- **A05:2021 – Security Misconfiguration:** ✅ Helmet.js, CSP headers, minimal dependency surface
- **A06:2021 – Vulnerable & Outdated Components:** ✅ Exact pinning on security-sensitive packages, weekly Dependabot on both ecosystems
- **A07:2021 – Authentication Failures:** ✅ bcrypt (12 rounds) + JWT, timing-safe login, single-login enforcement
- **A08:2021 – Data Integrity Failures:** ✅ JWT signature validation, upload content verified by magic bytes and structure, not just extension
- **A09:2021 – Logging & Monitoring Failures:** ⚠️ Partial — structured logging and abuse-pattern anomaly detection are real and live; application crash/error reporting is not, and that gap is explicitly called out above rather than checked off
- **A10:2021 – SSRF:** ✅ Limited external API surface (Anthropic API only, for the AI Reel feature)

---

## Contact

- **Security inquiries:** greencompassgames@gmail.com
- **General support:** GitHub Issues or Discord

---

**Last Updated:** September 2026, verified against client v0.1.71

Peak-Abu is maintained by a single developer with security as a core priority. Your trust is essential — thank you for helping us keep Peak-Abu safe. 🔐