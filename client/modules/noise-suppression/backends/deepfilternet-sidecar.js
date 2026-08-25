/*
 * deepfilternet-sidecar.js — the DeepFilterNet backend slot.
 *
 * RUNS IN THE ELECTRON MAIN PROCESS, not the renderer. DeepFilterNet has no
 * browser build; it is a Rust crate with a Python API. To use it from
 * Peak-Abu you run it as a local process and pipe PCM through a socket.
 *
 * This speaks exactly the protocol described in the existing noise_suppressor
 * README, so the Python `service.py` from that module works unmodified:
 *
 *   1. On connect the server sends uint32 sample_rate (48000).
 *   2. Client sends uint32 length, then `length` bytes of mono PCM16LE.
 *   3. Server replies uint32 length, then that many bytes of denoised PCM16LE.
 *   4. Repeat for the life of the stream.
 *
 * All integers are 4-byte big-endian.
 *
 * WHY THIS IS NOT THE DEFAULT
 * ---------------------------
 * Be aware of what adopting this costs before wiring it into the live mic
 * path. It is a genuine quality upgrade over everything in the renderer, but:
 *
 *   - It needs Python + PyTorch + DeepFilterNet installed, or a bundled Rust
 *     binary built per platform. That is roughly 20MB-2GB depending on which
 *     route you take, against ~200KB for the in-renderer GTCRN model.
 *   - Round-tripping audio to another process adds latency on top of the
 *     model's own. The chunked Python `enhance()` API is not built for tight
 *     real-time; DeepFilterNet's Rust streaming engine (its LADSPA plugin, or
 *     `deepfilter-rt` on ONNX Runtime) is the path to low latency.
 *   - If the sidecar dies mid-session the mic must fall back instantly.
 *     `onFailure` exists for that and should be wired to a renderer backend.
 *
 * For live monitoring, prefer GTCRN in the renderer. This is the better fit
 * for OFFLINE cleanup of an already-recorded track, where latency is free —
 * which is also the lowest-risk way to ship DeepFilterNet at all.
 */

'use strict';

const net = require('net');
const { spawn } = require('child_process');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8765;

class DeepFilterNetSidecar {
  /**
   * @param {object} opts
   * @param {string} [opts.host]        service host
   * @param {number} [opts.port]        service port
   * @param {string} [opts.servicePath] path to service.py; enables autospawn
   * @param {string} [opts.python]      python executable
   * @param {boolean}[opts.postFilter]  DeepFilterNet's aggressive mode
   * @param {number} [opts.connectTimeoutMs]
   * @param {function}[opts.onFailure]  called if the link dies mid-stream
   */
  constructor(opts = {}) {
    this.host = opts.host || DEFAULT_HOST;
    this.port = opts.port || DEFAULT_PORT;
    this.servicePath = opts.servicePath || null;
    this.python = opts.python || 'python';
    this.postFilter = !!opts.postFilter;
    this.connectTimeoutMs = opts.connectTimeoutMs || 5000;
    this.onFailure = opts.onFailure || null;

    this.socket = null;
    this.child = null;
    this.sampleRate = null;
    this.connected = false;

    // process() is strictly request/response, so in-flight calls queue in
    // order. Without this a second call would consume the first's reply.
    this._queue = [];
    this._rx = Buffer.alloc(0);
  }

  /** Spawns service.py if a path was given. Safe to call when already up. */
  async start() {
    if (this.servicePath && !this.child) {
      const args = [this.servicePath];
      if (this.postFilter) args.push('--post-filter');
      this.child = spawn(this.python, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      this.child.on('exit', (code) => {
        this.child = null;
        this._fail(new Error(`noise_suppressor service exited (code ${code})`));
      });
      // The service binds its socket after loading the model, which is slow.
      await this._waitForPort();
    }
    return this.connect();
  }

  async _waitForPort() {
    const deadline = Date.now() + 30000;   // model load can take ~20s cold
    for (;;) {
      const ok = await new Promise((resolve) => {
        const probe = net.connect({ host: this.host, port: this.port }, () => {
          probe.destroy();
          resolve(true);
        });
        probe.on('error', () => resolve(false));
      });
      if (ok) return;
      if (Date.now() > deadline) throw new Error('noise_suppressor service never opened its port');
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  connect() {
    return new Promise((resolve, reject) => {
      const sock = net.connect({ host: this.host, port: this.port });
      const timer = setTimeout(() => {
        sock.destroy();
        reject(new Error('timed out connecting to noise_suppressor'));
      }, this.connectTimeoutMs);

      sock.on('connect', () => { sock.setNoDelay(true); });
      sock.on('data', (chunk) => this._onData(chunk));
      sock.on('error', (err) => { clearTimeout(timer); this._fail(err); reject(err); });
      sock.on('close', () => this._fail(new Error('noise_suppressor closed the connection')));

      // The handshake is the first 4 bytes: the service's sample rate.
      this._pendingHandshake = (rate) => {
        clearTimeout(timer);
        this.sampleRate = rate;
        this.connected = true;
        resolve(rate);
      };
      this.socket = sock;
    });
  }

  _onData(chunk) {
    this._rx = Buffer.concat([this._rx, chunk]);

    if (this._pendingHandshake) {
      if (this._rx.length < 4) return;
      const rate = this._rx.readUInt32BE(0);
      this._rx = this._rx.subarray(4);
      const cb = this._pendingHandshake;
      this._pendingHandshake = null;
      cb(rate);
    }

    // Drain as many complete length-prefixed frames as arrived.
    for (;;) {
      if (this._rx.length < 4) return;
      const len = this._rx.readUInt32BE(0);
      if (this._rx.length < 4 + len) return;
      const payload = Buffer.from(this._rx.subarray(4, 4 + len));
      this._rx = this._rx.subarray(4 + len);
      const waiter = this._queue.shift();
      if (waiter) waiter.resolve(payload);
    }
  }

  _fail(err) {
    this.connected = false;
    const q = this._queue;
    this._queue = [];
    q.forEach((w) => w.reject(err));
    if (this.socket) { try { this.socket.destroy(); } catch (e) {} this.socket = null; }
    if (this.onFailure) this.onFailure(err);
  }

  /**
   * Denoises one chunk of mono PCM16LE at the service's sample rate.
   * @param {Buffer} pcm16
   * @returns {Promise<Buffer>} same length, denoised
   */
  process(pcm16) {
    if (!this.connected || !this.socket) {
      return Promise.reject(new Error('noise_suppressor is not connected'));
    }
    return new Promise((resolve, reject) => {
      this._queue.push({ resolve, reject });
      const header = Buffer.allocUnsafe(4);
      header.writeUInt32BE(pcm16.length, 0);
      this.socket.write(header);
      this.socket.write(pcm16);
    });
  }

  /** Float32 [-1,1] convenience wrapper around process(). */
  async processFloat32(samples) {
    const pcm = Buffer.allocUnsafe(samples.length * 2);
    for (let i = 0; i < samples.length; i++) {
      let v = Math.max(-1, Math.min(1, samples[i]));
      pcm.writeInt16LE((v * 32767) | 0, i * 2);
    }
    const out = await this.process(pcm);
    const result = new Float32Array(out.length / 2);
    for (let i = 0; i < result.length; i++) result[i] = out.readInt16LE(i * 2) / 32767;
    return result;
  }

  stop() {
    this.connected = false;
    this._queue = [];
    if (this.socket) { try { this.socket.destroy(); } catch (e) {} this.socket = null; }
    if (this.child) { try { this.child.kill(); } catch (e) {} this.child = null; }
  }
}

module.exports = DeepFilterNetSidecar;
module.exports.DEFAULT_PORT = DEFAULT_PORT;
