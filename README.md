# Peak-Abu 🎮

**Synchronized multi-POV gaming highlight capture for squads, content creators, and esports teams, possibly more**

Peak-Abu lets gaming groups record their individual perspectives during a session, coordinate a synchronized save, and replay all POVs together through a web-based player with frame-perfect time sync.

---

## Why Peak-Abu?

- **Multi-POV replay** — capture 3–5+ player perspectives simultaneously and watch them sync'd in a single player
- **Squad-friendly** — designed for gaming squads
- **Smart tier structure** — free users participate (local clips only); paid tiers unlock cloud storage and export
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
│   └── updater.js             # Self-update from DigitalOcean Spaces
├── server/                    # Node.js/Express + Socket.IO
│   ├── index.js               # Session management, clip coordination, auth
│   ├── aireel.js              # AI highlight reel pipeline (Anthropic API)
│   └── encoding/              # FFmpeg subprocess for MP4 export
└── web-player/                # Static HTML/JS
    ├── index.html             # React-based multi-POV viewer
    └── styles/                # Inline CSS (intentionally monolithic)
```

**Key technologies:**
- **Desktop:** Electron (Windows only), FFmpeg (gyan.dev full build)
- **Server:** Node.js 18+, Express, Socket.IO, PM2 (process manager)
- **Storage:** DigitalOcean Spaces (S3-compatible), nginx reverse proxy
- **Encoding:** libx264 (veryfast preset) for composite export, AV1/HEVC scoped for later
- **Auth:** JWT + bcrypt, session-based, HttpOnly cookies

---

## Important: This Is Source Code Only

**Cloning this repo will not give you a working Peak-Abu instance.** You also need:

1. **Infrastructure**
   - DigitalOcean droplet (or equivalent Linux VPS)
   - DigitalOcean Spaces bucket (or S3-compatible object storage)
   - Domain name + SSL certificates
   - PM2 for process management

2. **Secrets** (stored in `.env`, never committed)
   - `JWT_SECRET` — session signing key
   - `AIREEL_API_KEY` — Anthropic API key (optional, for AI reel feature)
   - `DO_SPACES_KEY`, `DO_SPACES_SECRET` — object storage credentials
   - `DATABASE_URL` — (currently local JSON, but placeholder for future expansion)

3. **FFmpeg build**
   - Windows desktop: bundled via gyan.dev full build
   - Server: system-installed or Docker image

4. **Knowledge**
   - Linux server administration (droplet setup, nginx, PM2)
   - AWS CLI or DO CLI for credential management
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
# Dev mode: no real S3, no real auth required yet
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

Peak-Abu is deployed on DigitalOcean:
- **Droplet:** `peak-abu-server` (147.182.231.47), 1 vCPU + 512 MB RAM
- **Storage:** `peakbu-media` Spaces bucket (nyc3 region)
- **Process manager:** PM2 (configured in `ecosystem.config.js`)
- **Reverse proxy:** nginx

**Deployment flow:**
1. Make changes locally
2. `git push` to main branch
3. SSH to droplet, `git pull` in `/opt/peak-abu`
4. `pm2 restart peak-abu --update-env` (if server files changed)
5. Static web player updates on `git pull` alone (no PM2 restart needed)

For the full deployment guide, **this is private to Peak-Abu core team only**. Contact maintainer.

---

## Feature Roadmap

### Current (v0.1.21)
- ✅ Multi-POV capture (Windows Electron)
- ✅ Coordinated save with clock sync
- ✅ Web-based synchronized replay
- ✅ MP4 export (composite or individual POV)
- ✅ Freemium tier structure
- ✅ Auto-update via Spaces

### Planned (v0.2+)
- 🔄 Dual audio sidecar (independent mic/desktop volume in player)
- 🔄 AI Highlight Reel (auto-generate best moments)
- 🔄 Adaptive bitrate streaming (HLS/DASH for bandwidth savings)
- 🔄 macOS/Linux support (Electron backend exists, OBS VirtualCam plugin TBD)
- 🔄 Better subscription tier gating
- 📋 Structured logging (Winston)
- 📋 Advanced analytics / churn tracking

---

## Security

See `SECURITY.md` for our security posture, threat model, and responsible disclosure process.

**Quick highlights:**
- All user input validated server-side
- Passwords hashed with bcrypt
- HTTPS everywhere (nginx + TLS)
- Secrets managed via environment variables
- No sensitive data logged
- Clip access gated by session token (JWT)

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

**Built with care by a single developer. If Peak-Abu saves your squad time, consider subscribing to help fund development.** ❤️