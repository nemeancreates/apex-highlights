# Security Policy

Peak-Abu takes security seriously. This document outlines our security posture, known limitations, and how to report vulnerabilities.

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
- All user input (clips, session data, passwords) validated on the server side
- Client-side validation is UX only; server-side is the authority
- No SQL injection risk (using JSON-based sessions, not SQL databases currently)
- XSS mitigated via Content Security Policy (CSP) headers in nginx

### Authentication & Sessions
- Passwords hashed with **bcrypt** (min 10 rounds)
- Sessions stored locally in `users.json` (hashed credentials only)
- JWT tokens signed with `JWT_SECRET` (environment variable, never committed)
- Session cookies marked `HttpOnly`, `Secure`, `SameSite=Strict`
- Token expiry enforced server-side (default 7 days)

### Authorization & Access Control
- Clip access gated by session token (JWT)
- Users can only access clips from sessions they are part of
- Server validates every request for proper authorization
- No "security by UI" — buttons hidden from unauthorized users don't prevent API access

### Data Protection
- **HTTPS everywhere** (nginx reverse proxy with TLS)
- Sensitive fields (passwords, JWT secrets) never logged
- Clips stored in DigitalOcean Spaces (encrypted in transit via HTTPS)
- Local clip cache on user's PC is user's responsibility

### Secrets Management
- `.env` file containing `JWT_SECRET`, `AIREEL_API_KEY`, Spaces credentials
- `.env` is `.gitignore`d — never committed to git
- Secrets managed via environment variables in PM2 `ecosystem.config.js`
- No hardcoded API keys or credentials in source code

### Dependency & Supply Chain Security
- Dependencies pinned in `package-lock.json`
- Regular audits: `npm audit` before release
- Outdated or unmaintained packages flagged for replacement
- Node.js LTS version only (`18.x` or `20.x`)

### Logging & Monitoring
- Authentication events logged (login, logout, failed auth)
- No passwords or personal data in logs
- Logs rotated to prevent disk fill
- Server errors logged but not sent to client (prevents info leakage)
- Intrusion detection via fail2ban (scoped for v0.2 hardening)

### API & Network
- REST API endpoints require JWT or session token
- Socket.IO connections authenticated via JWT handshake
- Rate limiting on auth endpoints (scoped for v0.2)
- CORS policy restricts browser requests to peakabu.app origin only
- Internal APIs (e.g., `/admin`) restricted to localhost or VPN

---

## Known Limitations & Trade-offs

### Electron Client (Windows Only)
- **Reverse engineering risk:** Electron apps are packaged as ASAR archives, which can be extracted. The compiled JavaScript and bundled assets are readable.
  - **Mitigation:** Sensitive logic (auth, clip access checks) happens server-side. Client is trusted only for UI.
  - **Why:** Electron on Windows is the only practical way to capture multi-engine (DDagrab, GDI, OBS) without asking users to compile native C++ bindings.

### Socket.IO Persistence
- **Denial of Service risk:** A malicious actor could open many Socket.IO connections to exhaust droplet memory.
  - **Mitigation:** Connection limits enforced per user; automatic cleanup of stale connections after 30 min inactivity.
  - **Planned:** Rate limiting per IP (fail2ban integration).

### Local JSON Session Store
- **Scalability:** Using `sessions.json` on disk instead of a real database means concurrent writes could race.
  - **Mitigation:** Currently acceptable at ~10–100 concurrent users. Upgrade to PostgreSQL + Redis before 1.0.
  - **Risk:** Very low for current user base; high for production scale.

### FFmpeg Subprocess
- **Code injection risk:** If user-supplied clip names or metadata aren't sanitized, they could inject shell commands.
  - **Mitigation:** All FFmpeg arguments passed as array (not shell string) via Node `child_process.spawn()`. No shell interpolation.
  - **Status:** ✅ Already implemented safely.

### Droplet Access
- **SSH key management:** Droplet accessible only via SSH key, not password auth.
  - **Mitigation:** SSH keys stored securely; never shared. Rotate if team member leaves.
  - **Planned:** Dedicated deployment user (not root) with sudo restrictions.

### DigitalOcean Spaces
- **Bucket policy:** Spaces bucket is **public for reading** (clips must be playable without auth).
  - **Mitigation:** Clip URLs are long, random session codes; brute-forcing is computationally infeasible. Server-side access checks prevent non-members from requesting specific clip URLs.
  - **Risk:** Someone who knows a clip's direct S3 URL can view it even if not in the session. This is intentional (clips are shareable by design). Non-members cannot enumerate all clips.

### Browser Security (Web Player)
- **CSP:** Strict Content Security Policy prevents inline scripts and external resource loading.
- **CORS:** Player only accepts requests from `peakabu.app`.
- **XSS:** Input validation on all clip metadata (titles, notes) before rendering.

---

## Threat Model

### In Scope (We Protect Against)
- ✅ Unauthorized users viewing/downloading clips
- ✅ Session hijacking via stolen JWT
- ✅ SQL injection (if DB added)
- ✅ Cross-site scripting (XSS) via malicious clip names
- ✅ Weak password attacks (bcrypt + enforcement)
- ✅ Man-in-the-middle (HTTPS everywhere)
- ✅ Accidental data exposure (no secrets in logs)

### Out of Scope (We Accept Risk)
- ❌ Malicious actor reverse-engineers Electron binary and extracts FFmpeg filter chains
- ❌ DigitalOcean breach (responsibility of cloud provider)
- ❌ User loses local password manager and forgets Peak-Abu password
- ❌ User's PC is compromised; attacker reads local clip cache
- ❌ Nation-state adversary with resources to crack bcrypt hashes (acceptable: bcrypt is industry standard)

---

## Security Checklist for Future Releases

### v0.2 Hardening
- [ ] Structured logging with Winston (no secrets logged)
- [ ] Rate limiting on auth endpoints (prevent brute force)
- [ ] fail2ban integration (block repeated failed logins)
- [ ] Audit log for clip access (who watched what, when)
- [ ] Refresh token rotation (separate short-lived + long-lived tokens)
- [ ] Two-factor authentication (2FA) for paid tiers
- [ ] OWASP Top 10 security testing (automated + manual)

### Pre-1.0 (Before Public Marketing)
- [ ] Penetration testing by third party
- [ ] GDPR compliance audit (data deletion, privacy policy)
- [ ] Security.txt file (https://securitytxt.org/) for responsible disclosure
- [ ] Automated dependency scanning (Dependabot or Snyk)
- [ ] Upgrade droplet to 2 vCPU / 2 GB RAM (reduce OOM risk)
- [ ] Database migration (PostgreSQL + Redis, not JSON files)
- [ ] API versioning (graceful deprecation of old endpoints)

### Post-Launch Maintenance
- [ ] Monthly `npm audit` and dependency updates
- [ ] Quarterly security review (code audit, log analysis)
- [ ] Incident response playbook (breach notification, customer comms)
- [ ] Regular backups of `peakbu-media` Spaces bucket (Nemesis: DigitalOcean snapshots)

---

## Compliance & Standards

Peak-Abu is designed with OWASP Top 10 and Microsoft SDL principles in mind:

- **A01:2021 – Broken Access Control:** Server-side authorization checks on every request ✅
- **A02:2021 – Cryptographic Failures:** HTTPS everywhere, secrets in environment ✅
- **A03:2021 – Injection:** Input validation, FFmpeg args via spawn (no shell) ✅
- **A04:2021 – Insecure Design:** Threat modeling during development ✅
- **A05:2021 – Security Misconfiguration:** Minimal dependencies, CSP headers ✅
- **A06:2021 – Vulnerable & Outdated Components:** Package pinning, regular audits ✅
- **A07:2021 – Authentication Failures:** Bcrypt + HttpOnly tokens ✅
- **A08:2021 – Data Integrity Failures:** JWT signature validation ✅
- **A09:2021 – Logging & Monitoring Failures:** Auth logging, intrusion detection planned ✅
- **A10:2021 – SSRF:** Limited external API calls (Anthropic only for AI reel) ✅

---

## Contact

- **Security inquiries:** greencompassgames@gmail.com
- **General support:** GitHub Issues or Discord


---

**Last Updated:** July 2026

Peak-Abu is maintained by a single developer with security as a core priority. Your trust is essential — thank you for helping us keep Peak-Abu safe. 🔐
