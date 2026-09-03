# Peak-Abu 🎮

**Synchronized multi-POV gaming highlight capture for squads, content creators, and esports teams, possibly more**

Peak-Abu lets gaming groups record their individual perspectives during a session, coordinate a synchronized save, and replay all POVs together through a web-based player with frame-perfect time sync.

---

## Why Peak-Abu?

- **Multi-POV replay** — capture 3–5+ player perspectives simultaneously and watch them sync'd in a single player, no account needed to view a shared session
- **Squad-friendly** — designed for gaming squads
- **Smart tier structure** — free users participate (local clips only); paid tiers unlock cloud storage, AI-assisted highlight reels, and export
- **Low infrastructure cost** — inverts the SquadOV failure mode (unlimited free tier → unsustainable). Our free tier is intentionally limited, keeping ops costs sustainable
- **Lean codebase** — single developer, clean architecture, heavily commented for readability

---

## Architecture Overview

```
Peak-Abu
├── client/                    # Electron desktop app (Windows)
│   ├── main.js                # IPC, auto-update, FFmpeg bridge
│   ├── engine/                # Capture engines (DDagrab, GDI, OBS VirtualCam fallback)
│   ├── recorder.js            # Per-POV recording + audio sync logic
│   ├── modules/                # Settings tabs: appearance, av-check, noise suppression
│   └── updater.js             # Self-update from Cloudflare R2
├── server/                    # Node.js/Express + Socket.IO
│   ├── index.js               # Session management, clip coordination, auth
│   ├── stores.js               # SQLite (better-sqlite3) persistence layer
│   ├── aireel.js              # AI highlight reel pipeline (Anthropic API + local render path)
│   ├── anomaly.js              # Abuse-pattern monitoring (session/upload/registration bursts)
│   ├── killswitch.js           # Runtime-toggleable pause for new sessions/registrations
│   └── encoding/               # FFmpeg subprocess for MP4 export (individual + composite)
└── web-player/                # Static HTML/JS
    ├── index.html             # React-based multi-POV viewer
    └── styles/                # Inline CSS (intentionally monolithic)
```

**Key technologies:**
- **Desktop:** Electron (Windows only), FFmpeg (gyan.dev full build — required for ddagrab/zscale filters)
- **Server:** Node.js 18+, Express, Socket.IO, PM2 (process manager)
- **Database:** SQLite via `better-sqlite3` — local file, no external DB server needed
- **Storage:** Cloudflare R2 (S3-compatible, zero egress fees), nginx reverse proxy
- **Encoding:** libx264 (veryfast preset) for composite export, AV1/HEVC scoped for later
- **Auth:** JWT + bcrypt (12 rounds), verified server-side via middleware on both HTTP and Socket.IO connections

---

## Important: This Is Source Code Only

**Cloning this repo will not give you a working Peak-Abu instance.** You also need:

1. **Infrastructure**
   - DigitalOcean droplet (or equivalent Linux VPS)
   - Cloudflare R2 bucket (or any S3-compatible object storage)
   - Domain name + SSL certificates
   - PM2 for process management

2. **Secrets** (stored in `.env`, never committed)
   - `JWT_SECRET` — session signing key (server fails fast at boot if unset)
   - `ADMIN_SECRET` — gates admin-only routes
   - `ANTHROPIC_API_KEY` — optional, powers the AI Reel editorial step; a heuristic fallback runs automatically if unset
   - R2 access key/secret + endpoint — object storage credentials
   - `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET` — optional, enables Discord account linking + password recovery

3. **Database**
   - SQLite file, created automatically on first run via `better-sqlite3` — no separate DB server to stand up

4. **FFmpeg build**
   - Windows desktop: bundled via gyan.dev full build
   - Server: system-installed or Docker image

5. **Knowledge**
   - Linux server administration (droplet setup, nginx, PM2)
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

For full local setup with mock data and no external dependencies, see `DEVELOPMENT.md` (if available).

---

## Production Deployment

Peak-Abu is deployed on DigitalOcean + Cloudflare:
- **Droplet:** `peak-abu-server` (147.182.231.47), 1 vCPU / 1GB+ RAM
- **Storage:** `peakabu-media` R2 bucket (Cloudflare)
- **Process manager:** PM2 (configured in `ecosystem.config.js`, gitignored — not tracked in this repo)
- **Reverse proxy:** nginx

**Deployment flow:**
1. Make changes locally, `git add`/`commit`/`push` to main branch
2. SSH to droplet, `git pull --rebase` in `/opt/peak-abu` (rebase, not merge — droplet sometimes has local runtime-written files)
3. `node --check <changed file>` before restarting — a syntax error caught here is a lot cheaper than one caught by PM2's crash loop
4. `pm2 restart peak-abu --update-env` (if server files changed)
5. Static web player updates on `git pull` alone (no PM2 restart needed)
6. Client builds are versioned separately and uploaded to R2 — see the release process for details

For the full deployment guide, **this is private to Peak-Abu core team only**. Contact maintainer.

---

## Feature Roadmap

### Current (v0.1.70)
- ✅ Multi-POV capture (Windows Electron)
- ✅ Coordinated save with clock sync
- ✅ Web-based synchronized replay, no account needed to view
- ✅ MP4 export — individual POV or server-side composite (grid layout, comment overlay)
- ✅ Freemium tier structure with per-feature capability flags (not hardcoded tier checks)
- ✅ Auto-update via Cloudflare R2
- ✅ AI Highlight Reel — Anthropic API-assisted edit decision list (heuristic fallback if no key set), rendered locally or server-side
- ✅ Discord account linking + Discord-based password recovery
- ✅ Host moderation: kick/ban
- ✅ Noise suppression (multiple backends with fallback chain)
- ✅ Auto-close sessions on host inactivity
- ✅ Abuse-pattern monitoring (registration/session/upload burst detection)

### Planned (v0.2+)
- 🔄 Adaptive bitrate streaming (HLS/DASH for bandwidth savings)
- 🔄 macOS/Linux support (Electron backend exists, capture engine TBD)
- 🔄 Formal role-based access beyond host/member (participant/viewer distinction)
- 📋 Application crash reporting & error observability — currently the most significant gap; see `SECURITY.md`
- 📋 Load testing at real backer-scale concurrency
- 📋 Written incident response plan

---

## Security

See `SECURITY.md` for our security posture, threat model, and responsible disclosure process — including an honest list of what's still open, not just what's done.

**Quick highlights:**
- All user input validated server-side, including upload magic-byte verification (not just file extension)
- Passwords hashed with bcrypt (12 rounds)
- HTTPS everywhere (nginx + TLS)
- Secrets managed via environment variables, never committed
- No sensitive data logged
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

See `LICENSE` for full legal terms.

---

## Support & Feedback

- **Bug reports:** GitHub Issues
- **Feature requests:** GitHub Discussions
- **Security vulnerabilities:** See `SECURITY.md`
- **General questions:** Discord (link TBD) or email

---

## Changelog

See `CHANGELOG.md` for version history, or GitHub Releases for detailed notes per version.

---

**Last verified against live code:** September 2026, client v0.1.70

**Built with care by a single developer. If Peak-Abu saves your squad time, consider subscribing to help fund development.** ❤️