# Video Stutter Handoff (10-3-26, v0.1.89)

**For:** whoever picks up choppy clips next (and their Claude)
**From:** Nemean, investigated with Claude on 2026-10-03
**Base version:** 0.1.88. Low Bandwidth Mode fix in 0.1.89 (commit `2aa73d3`, pushed, not released yet)
**Status:** the stutter's cause is found: it's recorded into the clip, not caused by uploading. Not fixed yet; next steps are at the end. A Low Bandwidth Mode bug found along the way is fixed in 0.1.89.

Session codes are left out on purpose: anyone with a code can watch those clips. Nemean has them.

---

## Symptom

- In party sessions, one player's clips (often Nemean's) look skippy or low frame rate in the web player.
- Solo sessions seemed fine at 1080p 60 fps.
- The suspicion: several clips uploading at once damage the uploads, since the clips "play fine in the folder".
- Separately, Low Bandwidth Mode (🐢) switched itself on even on decent connections, and videos didn't upload until the player turned it off.

## Short answer

1. **Uploads don't change videos.** Every uploaded clip is the same file as the one on disk. The stutter is already in the local file.
2. **The stutter is repeated frames from capture.** Game Window mode captured about 6 real frames per second in Valheim. Screen mode at 30 fps was clean in every game tried.
3. **It isn't a party thing.** A solo Valheim session the same afternoon was just as choppy.
4. **Low Bandwidth Mode held videos back.** RecycledDonut's first 5 videos waited ~3 minutes until the mode was switched off. Fixed in 0.1.89.

## What was looked at

- **Party session** (Valheim, 10/3 19:58–23:45 UTC): Nemean + RecycledDonut, 641 clips, 327 highlights (one every ~42 s), about 9 GB per player.
- **Solo session** (Valheim, 10/3 17:22–19:13 UTC): Nemean, 93 clips.
- Every other session folder in `Videos\PeakAbu` (Fortnite, Wardogs, Cyberpunk, Kingdom Hearts), 5 clips each.
- The upload list the web player reads (`GET /sessions/<code>/uploads`), each clip's metadata JSON and container info, and Nemean's local copies.

## How stutter was measured

A clip looks skippy when many frames are exact repeats of the one before: capture had nothing new, so the encoder filled the gap. "Real fps" below means frames per second that actually changed.

- **Decode method (any clip):**
  ```
  ffmpeg -v error -i clip.mp4 -an -vf "scale=480:-2,format=gray,tblend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=diff.txt" -f null -
  ```
  A frame counts as repeated when its YAVG (average difference from the previous frame) is under 0.05. Normal gameplay sits between 0.1 and 20.
- **Fast method (Screen-mode clips only):** count non-key frames under 2,000 bytes, read from the MP4 index (`stsz`) with HTTP range requests, so only the index downloads. It matched the decode method closely on 25 test clips. It doesn't work for Game Window clips, because those are re-encoded at save time.

## Findings

### 1. Uploaded files are identical to local files

- All 314 of Nemean's party-session clips are exactly the same size on the server as on disk.
- 6 clips compared by SHA-256, including the worst ones, are byte-identical: `20-43-55-049Z`, `20-56-02-950Z`, `20-35-22-719Z` (Screen 30, ~52–54% repeats), `20-05-27-501Z`, `20-05-55-100Z` (Game Window 60), `20-29-41-261Z` (clean).
- The server stores uploads as they arrive (multer, then R2; `server/media.js` only makes thumbnails). Nothing re-encodes them.
- Every clip's frame count matches its frame rate times its length. Two Game Window clips are shorter than their metadata says (20:00:35 is 15.8 s of 30, 20:03:13 is 17.9 s of 30). That's a separate small bug.

### 2. Capture mode decides it

| Session | Mode | Clips | Repeated frames | Real fps |
|---|---|---|---|---|
| Party, Nemean 19:58–20:21 | Game Window 60 | 32 | ~90% (47–96%) | ~6 |
| Party, Nemean 20:21 | Game Window 30 | 1 | 85% | ~5 |
| Party, Nemean 20:29–23:45 | Screen 30 | 281 | median 1% | ~30 |
| Party, RecycledDonut | Screen 30 (3440×1440) | 327 | median 6% | ~28 |
| Solo, Nemean | Game Window 60 | 89 | ~90% | ~6 |
| Solo, Nemean | Screen 60 | 4 | ~95% | ~3 |
| Fortnite, 9/26 | Screen 60 | 39 | ~3% | ~58 |
| Fortnite, 9/28 | Game Window 60 | 29 | ~32% | ~41 |
| Wardogs, 9/25 and 9/28 | Game Window 60 | 55 / 37 | ~57% / ~71% | ~26 / ~17 |
| Wardogs, 9/27 | Screen 30 | 47 | ~0% | ~30 |
| Cyberpunk, 10/2 | Screen 60 | 42 | ~17% | ~50 |

The Claude and Solo folders were left out: they're app and desktop captures where the screen often doesn't change, so repeats are expected there.

**Why Game Window mode repeats frames.** It records through Chromium: `getUserMedia` desktop capture plus `MediaRecorder` (`client/index.html`, `wgcStartCapture` and `wgcCreateRecorder`). For a game window that stream only delivers some of the frames. At save time `main.js` re-encodes it with `-fps_mode cfr -r <fps>` (the WGC branch of `doSaveHighlight`), which fills every gap by repeating the last frame. Dropping Game Window to 30 fps didn't help (85% repeats).

**Screen mode** (ddagrab plus NVENC) repeats a frame only when the desktop didn't change: the game drew fewer frames than the capture rate, or the GPU was saturated. In Valheim it captured ~3 real fps at 60 fps and was clean at 30 fps. Valheim is GPU-heavy, so GPU saturation fits.

### 3. Not party vs solo, not uploads

- The solo Valheim session was as choppy as the party one.
- Repeated frames don't rise when uploads run during the recording. Correlation between a clip's repeats and the seconds of upload overlapping its recording: −0.29 (Nemean), −0.21 (RecycledDonut). With saves just before it: 0.02 and 0.00.
- The two players' repeats at the same moments barely relate (0.26), so it isn't the game world or the server either.

### 4. One stretch not explained

Nemean's Screen 30 clips from **20:30 to 21:00 UTC** are ~45% repeats (~16 real fps), then clean from about 21:15. RecycledDonut's clips at the same moments were fine. So it was something on Nemean's PC: most likely Valheim itself running ~16 fps in a heavy area, or something else loading the GPU. An in-game FPS counter next session would settle it.

## Uploads and Low Bandwidth Mode

### What happened in the party session

- RecycledDonut started with Low Bandwidth Mode on. Their first 5 clips sent only sync data. The videos sat ~3 minutes until the mode was switched off at ~20:02, then all 5 uploaded by 20:04.
- Until ~22:10 their uploads kept up with what they recorded (~5–6 Mbps). After ~22:20 their line only delivered ~3–4.5 Mbps, so clips fell behind: about 30 clips (~800 MB) were waiting when the session ended, and the last one landed 34 minutes after the final highlight.
- Nemean's uploads kept pace (median 32 s from highlight to landed). The 13-minute delay during Nemean's Game Window stretch was most likely the save queue (Game Window saves re-encode), not the upload.
- Every save starts its own upload right away (`doUploadHighlight` calls `performUpload`); only the retry sweep goes one at a time. On a slow line many clips share it, so each lands later. It never changes the file.

### Why Low Bandwidth Mode misfired

1. Auto turned it on below 10 Mbps measured upload. Plenty of ordinary connections sit there and keep up fine.
2. The speed test is one 3 MB upload on a fresh connection, and it reads low on a high-latency line: modeled, a 10 Mbps line reads ~8.6 at 120 ms. One bad reading stuck for 24 hours, and a test that timed out was saved as 0.4 Mbps.
3. In the mode, a video only starts after 20 s with no save or auto-capture. With a highlight every ~42 s that quiet rarely came, and any fight slowed a sending video to 0.13 Mbps.
4. Even when sending, it uses 60% of the measured speed. That can be less than a busy session produces, so the queue only grows.

### Upload time for a typical clip

A typical clip is 30 s at 8 Mbps, about 30 MB. A busy session needs ~5.4 Mbps of steady upload per player.

| Upload speed | Typical of | Time per clip | Busy session |
|---|---|---|---|
| 3 Mbps | slow DSL, weak cellular | ~80 s | Can't keep up |
| 5 Mbps | average DSL | ~48 s | Line full the whole session |
| 10 Mbps | slower cable, rural wireless | ~24 s | Keeps up (uses ~55% of the line) |
| 12 Mbps | average satellite | ~20 s | Keeps up |
| 22–28 Mbps | 5G home, average cable | ~9–11 s | Easily |
| 100+ Mbps | fiber | ~2 s | Easily |

Connection averages from SpeedTestHQ, April 2026: DSL 5, satellite 12, 5G home 22, cable 28, fiber 510 Mbps upload.

### Fixed in 0.1.89 (commit `2aa73d3`)

- Auto turns Low Bandwidth Mode on below **5 Mbps** (was 10): `LOW_BW_THRESHOLD_MBPS` in `client/upload-queue.js`.
- A reading under 5 Mbps, a timeout included, is **tested once more** and the better result is kept (`measureUploadSpeed`).
- A held video waits **2 minutes at most** (`LBM_MAX_HOLD_MS`, `isOverdue`). After that it uploads at the normal Low Bandwidth rate even mid-fight, with no trickle. `main.js` gives each upload its own rate (`uploadRateFor`) and starts a sweep when a clip goes overdue.
- The 📤 tab and its tooltips say so. Version bumped in the three places.
- **Checks:** `node --check` on every changed file, the inline scripts in `index.html` parse, CRLF kept, 24 unit tests pass (including a real speed test against a local server). **Not tried in a live session yet.**
- **Deploy order:** build the 0.1.89 installer and upload it to R2 first, then `git pull --rebase` and `pm2 restart peak-abu --update-env` on the server, because the config now advertises 0.1.89. The web player didn't change.

## Ruled out

- Upload corruption: identical bytes (finding 1).
- Server processing: stored as uploaded.
- Uploads disturbing capture: no correlation (finding 3).
- Party vs solo: solo was just as bad.
- Web player playback: the 9-29 playback fix is live (the live player matches the committed file), and the repeats are in the files themselves.
- A lower frame rate in Game Window mode: 30 fps still had ~85% repeats.

## Next steps (not built)

1. **Release 0.1.89** in the deploy order above, then a 2-player session to confirm Low Bandwidth Mode behaves.
2. **Capture check.** After each save, measure the clip's real frame rate (ffmpeg's own `dup=` count for Game Window saves, the small-frame share for Screen saves), store `realFps` in the clip's metadata, and after 3 choppy clips in a row show one HUD line suggesting Screen mode at 30 fps.
3. **Rebuild Game Window mode on FFmpeg 8.1's `gfxcapture`** (native Windows Graphics Capture that can target one window), encoded with NVENC like Screen mode, instead of Chromium's capture. The bundled FFmpeg is 7.1.5, so this needs an upgrade and testing.
4. **One upload at a time, oldest first,** for live saves too, so clips land steadily on slow lines.
5. **The 20:30–21:00 stretch:** keep an in-game FPS counter on next session.
6. **The two short Game Window clips** (finding 1): find out why their extract stopped early.
7. **Re-upload-if-worse idea: parked.** It would have replaced 0 of 314 clips, since uploads are identical. For a safety net anyway: the retry sweep already reads each clip's server size, so logging a size mismatch is nearly free. If a replace route is ever needed, it should work past the 4-hour delete window and leave `uploadedAt`, the session expiry, the host-activity timer and the clip weight alone.

## Files

- Code: `client/upload-queue.js`, `client/main.js`, `client/index.html`, `client/package.json`, `server/config.js` (commit `2aa73d3`).
- Nemean has the measuring scripts (the decode method over every local session folder, frame sizes from a clip's index over HTTP) and the 0.1.89 unit tests on their PC. They aren't in the repo.
