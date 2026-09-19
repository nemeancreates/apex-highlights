# Peak-Abu 🎮

**Synchronized multi-POV gaming highlight capture for squads, content creators, and esports teams, possibly more**

Peak-Abu lets gaming groups record their individual perspectives during a session, coordinate a synchronized save, and replay all POVs together through a web-based player with frame-perfect time sync.

---

## Why Peak-Abu?

- **Multi-POV replay** — capture 3–5+ player perspectives simultaneously and watch them sync'd in a single player, no account needed to view a shared session
- **Squad-friendly** — designed for gaming squads
- **Smart tier structure** — paid tiers unlock longer retention, larger squads, AI-assisted highlight reels, and export
- **Low infrastructure cost** — inverts the SquadOV failure mode (unlimited free tier → unsustainable). Our free tier is intentionally limited, keeping ops costs sustainable
- **Lean codebase** — single developer, clean architecture, heavily commented for readability

---

## Architecture Overview

```
Peak-Abu
├── client/                     # Electron desktop app (Windows)
│   ├── main.js                 # Capture engines, FFmpeg bridge, IPC, uploads, buffer management
│   ├── index.html              # Renderer — UI, auto-capture detection, socket client
│   ├── updater.js              # Self-update from Cloudflare R2
│   ├── aireel-client.js        # Local (client-side) AI Reel render path
│   ├── aireel-window.html      # AI Reel window
│   ├── sentry-config.js        # Crash-reporting DSN
│   ├── modules/                # Settings tabs
│   │   ├── appearance/
│   │   ├── av-check/
│   │   └── noise-suppression/  # Backends + vendored WASM worklets
│   └── ffmpeg/                 # Bundled gyan.dev build (shipped via extraResources)
├── server/                     # Node.js/Express + Socket.IO
│   ├── index.js                # Entry point — wiring only, no logic
│   ├── config.js               # Tiers, limits, every tunable constant
│   ├── db.js                   # SQLite connection + schema + migrations
│   ├── stores.js               # Users and sessions state, write-through to SQLite
│   ├── auth.js                 # JWT, bcrypt, Discord OAuth, tier gates
│   ├── routes/                 # sessions.js, join.js, uploads.js, comments.js
│   ├── sockets/                # index.js, highlights.js (coordinated save), autocapture.js
│   ├── aireel.js               # AI highlight reel pipeline (Anthropic API + heuristic fallback)
│   ├── composite.js            # Server-side FFmpeg grid export (xstack + ASS overlay)
│   ├── media.js                # Thumbnail generation queue
│   ├── spaces.js               # Cloudflare R2 client (name predates the migration)
│   ├── anomaly.js              # Abuse-pattern monitoring (session/upload/registration bursts)
│   └── killswitch.js           # Runtime-toggleable pause for new sessions/registrations
└── web-player/
    └── index.html              # Vanilla-JS multi-POV viewer, single self-contained file
```

**Key technologies:**
- **Desktop:** Electron (Windows only), FFmpeg (gyan.dev full build — required for ddagrab/zscale filters)
- **Capture:** OS-level only — DDagrab (GPU), GDI (legacy), Windows Graphics Capture for window mode. Nothing is injected into game processes
- **Server:** Node.js 18+, Express, Socket.IO, PM2 (process manager)
- **Database:** SQLite via `better-sqlite3` — local file, no external DB server needed
- **Storage:** Cloudflare R2 (S3-compatible, zero egress fees), nginx reverse proxy
- **Encoding:** NVENC where available, libx264 fallback; libx264 (veryfast) for composite export; AV1/HEVC scoped for later
- **Auth:** JWT + bcrypt (12 rounds), verified server-side via middleware on both HTTP and Socket.IO connections
- **Observability:** Sentry crash reporting on both the client (Electron, with Crashpad) and server (Node) — catches unhandled exceptions on both sides rather than failing silently

---

## Important: This Is Source Code Only

**Cloning this repo will not give you a working Peak-Abu instance.** You also need:

1. **Infrastructure**
   - A Linux VPS
   - Cloudflare R2 bucket (or any S3-compatible object storage)
   - Domain name + SSL certificates
   - PM2 for process management

2. **Secrets** (stored in `.env`, never committed)
   - `JWT_SECRET` — session signing key (server fails fast at boot if unset)
   - `ADMIN_SECRET` — gates admin-only routes
   - `ANTHROPIC_API_KEY` — optional, powers the AI Reel editorial step; a heuristic fallback runs automatically if unset
   - `R2_ACCOUNT_ID`, `SPACES_KEY`, `SPACES_SECRET`, `SPACES_BUCKET`, `SPACES_CDN_BASE` — object storage credentials
   - `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET` — optional, enables Discord account linking + password recovery
   - `DISCORD_BOT_TOKEN` / `DISCORD_GUILD_ID` / `DISCORD_ROLE_T1`–`T5` — optional, enables Discord role sync on tier change

3. **Database**
   - SQLite file, created automatically on first run via `better-sqlite3` — no separate DB server to stand up

4. **FFmpeg build**
   - Windows desktop: bundled via gyan.dev full build
   - Server: system-installed or Docker image

5. **Knowledge**
   - Linux server administration (VPS setup, nginx, PM2)
   - AWS CLI (or equivalent) for R2 credential management
   - Basic DevOps (git deployment, environment variable management)

**If you clone this and try to run it without these, the server won't start and the client won't connect.**

---

## Development Setup (Local)

### Prerequisites
- Node.js 18+
- FFmpeg (gyan.dev full build for Windows; system FFmpeg on Linux)
- Git

### Install & Run Locally

```bash
# Clone the repo
git clone https://github.com/nemeancreates/apex-highlights.git
cd apex-highlights

# Install server dependencies
cd server
npm install

# Install client dependencies
cd ../client
npm install

# Create a .env file in server/ (see below)
# Dev mode: SQLite file created automatically, no real R2 or Discord config required yet
echo "JWT_SECRET=dev-key-not-for-production" > .env
echo "NODE_ENV=development" >> .env

# Start server (from server/ directory)
npm start

# In another terminal, start client (from client/ directory)
npm start
```

Without R2 credentials the server runs in local-storage mode: clips stay in `server/uploads/` and are served from `/media`.

---

## Production Deployment

Peak-Abu is deployed on a Linux VPS behind nginx, with Cloudflare R2 for media storage and PM2 as the process manager. Host details, credentials and the full deployment guide are **private to the Peak-Abu core team** — contact the maintainer.

**Deployment flow (server changes):**
1. Make changes locally, `git add`/`commit`/`push` to main
2. On the server, `git pull --rebase` (rebase, not merge — the host has local runtime-written files)
3. `node --check <changed file>` before restarting — a syntax error caught here is a lot cheaper than one caught by PM2's crash loop
4. `pm2 restart peak-abu --update-env`
5. Static web player updates on `git pull` alone (no PM2 restart needed)

Client builds are versioned separately and uploaded to R2 — see the release process for details.

---

## Feature Roadmap

### Current (v0.1.78)
- ✅ Multi-POV capture (Windows Electron) — DDagrab, GDI, and window-capture engines with automatic fallback
- ✅ Coordinated save with clock sync
- ✅ Web-based synchronized replay, no account needed to view
- ✅ MP4 export — individual POV or server-side composite (grid layout, comment overlay)
- ✅ Tier structure with per-feature capability flags on a single TIERS object
- ✅ Auto-update via Cloudflare R2
- ✅ AI Highlight Reel — Anthropic API-assisted edit decision list (heuristic fallback if no key set), rendered locally or server-side
- ✅ Discord account linking, Discord-based password recovery, and role sync
- ✅ Host moderation: kick/ban, with a persisted per-session ban list
- ✅ Noise suppression (multiple backends with fallback chain)
- ✅ Auto-close sessions on host inactivity
- ✅ Abuse-pattern monitoring (registration/session/upload burst detection)
- ✅ Application crash reporting on both client and server (Sentry)
- ✅ Quick comments — timestamped notes anchored to a single POV clip
- ✅ Upload throttling, so a clip upload doesn't saturate upstream and spike in-game ping

### Planned (v0.2+)
- 🔄 Adaptive bitrate streaming (HLS/DASH for bandwidth savings)
- 🔄 macOS/Linux support (Electron backend exists, capture engine TBD)
- 🔄 AMD and Intel hardware encoder paths (currently NVENC or CPU)
- 🔄 Formal role-based access beyond host/member (participant/viewer distinction)
- 📋 Load testing at real backer-scale concurrency
- 📋 Written incident response plan
- 📋 Installer code signing

---

## Security

See `SECURITY.md` for our security posture, threat model, and responsible disclosure process — including an honest list of what's still open, not just what's done.

**Quick highlights:**
- All user input validated server-side, including upload magic-byte verification (not just file extension)
- Passwords hashed with bcrypt (12 rounds)
- HTTPS everywhere (nginx + TLS)
- Secrets managed via environment variables, never committed
- Auth tokens encrypted at rest on the client via the OS credential store (DPAPI on Windows)
- Clip and feature access gated by JWT + per-tier authorization checks on every request

---

## Contributing

Peak-Abu is currently solo-developed. **Community contributions are welcome**, but expect a slow review cycle.

### Before You Contribute
1. Open an issue describing the feature or bug fix
2. Wait for feedback before starting work
3. Follow the existing code style (see notes throughout codebase)
4. Test locally before submitting a PR

### Code Style
- JavaScript (Node.js/Electron): 2-space indentation, descriptive variable names
- Comments explain *why*, not *what*
- Each file has a header comment describing its role
- Tier limits go on the `TIERS` object in `server/config.js` as capability flags — never as a hardcoded tier array

---

## License

Peak-Abu is proprietary software. The source code is published for transparency and community learning, **not for forking or redeploying as a competing service**.

**You may:**
- Read and learn from the code
- Report security issues
- Suggest features or improvements

**You may not:**
- Fork and deploy a competing service
- Redistribute the code commercially
- Remove or obscure copyright notices

Peak-Abu bundles FFmpeg, which is distributed under its own licence — see `THIRD-PARTY-NOTICES.md`.

---

## Support & Feedback

- **Bug reports:** GitHub Issues
- **Feature requests:** GitHub Discussions
- **Security vulnerabilities:** See `SECURITY.md`
- **Community:** [Discord](https://discord.gg/HRepEcKWpM)

---

**Last verified against live code:** 18 September 2026, client v0.1.78

**Built with care by a single developer. If Peak-Abu saves your squad time, consider subscribing to help fund development.** ❤️
