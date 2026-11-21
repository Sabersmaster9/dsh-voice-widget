/**
 * dsh-voice-widget host half.
 *
 * Records the microphone with ffmpeg (DirectShow) and transcribes the clip with a
 * local whisper.cpp build, then hands the text to the page over loopback HTTP
 * routes. Everything is local and free: no cloud service, no account, no network
 * at runtime once the whisper binaries and model are provisioned.
 *
 * The toolchain lives in `%LOCALAPPDATA%\dsh-voice-widget\whisper`:
 *   bin\Release\whisper-cli.exe  (+ the DLLs that ship beside it)
 *   models\ggml-*.bin
 */
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Converter as createOpenCCConverter } from './vendor/opencc-t2cn.js';

/** Display name of this Cordis plugin. */
const name = 'dsh-voice-widget';
/** Host services that must exist before the routes can be registered. */
const inject = ['webServer'];
/** Route prefix claimed on the web server; the client half builds URLs from it. */
const ROUTE = '/dsh-voice-widget';
/** Longest single recording the host keeps alive, as a safety net. */
const MAX_SESSION_MS = 300_000;
/** How long ffmpeg gets to flush the WAV after a stop request. */
const STOP_GRACE_MS = 6_000;
/** How long one transcription may take before the host gives up on it. */
const TRANSCRIBE_TIMEOUT_MS = 180_000;
/** Extra capture kept after a stop click so trailing syllables land in the WAV. */
const TAIL_MS = 500;
/** How long a hover-primed capture waits to be claimed by a click. */
const PREWARM_TTL_MS = 15_000;
/** Bytes of WAV that prove ffmpeg is really capturing (≈0.15 s of 16 kHz mono). */
const LIVE_BYTES = 5_000;
/** Upper bound on waiting for the capture to go live. */
const LIVE_WAIT_MS = 4_000;

/** @param ms - delay in milliseconds. @returns a promise that resolves afterwards. */
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Prompt that keeps whisper on simplified Chinese and punctuated output. */
const ZH_PROMPT = '以下是简体中文普通话的句子，内容涉及软件界面、按钮、组件、代码和文件名。';

/**
 * Whisper's Chinese vocabulary leans traditional; the prompt only nudges it.
 * Rewrite every transcript through OpenCC so the page always gets simplified.
 */
let toSimplified = null;
function simplify(text) {
  if (typeof text !== 'string' || text === '') return text;
  try {
    toSimplified ??= createOpenCCConverter({ from: 't', to: 'cn' });
    return toSimplified(text);
  } catch {
    return text;
  }
}

/** @returns the per-user directory holding the toolchain and recordings. */
function dataDir() {
  const base = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
  const dir = join(base, 'dsh-voice-widget');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** @param dir - directory to list. @returns its entry names, or an empty list. */
function readdirSafe(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** @returns every whisper.cpp server executable that might exist, CUDA build first. */
function serverCandidates() {
  const root = join(dataDir(), 'whisper');
  return [
    join(root, 'cuda', 'Release', 'whisper-server.exe'),
    join(root, 'bin', 'Release', 'whisper-server.exe'),
    join(root, 'bin', 'whisper-server.exe'),
  ];
}

/** @returns every whisper.cpp command-line transcriber that might exist, CUDA first. */
function cliCandidates() {
  const root = join(dataDir(), 'whisper');
  return [
    join(root, 'cuda', 'Release', 'whisper-cli.exe'),
    join(root, 'bin', 'Release', 'whisper-cli.exe'),
    join(root, 'bin', 'whisper-cli.exe'),
    join(root, 'whisper-cli.exe'),
  ];
}

/** @returns the model paths present in the app-data tree, best first. */
function modelCandidates() {
  const dir = join(dataDir(), 'whisper', 'models');
  const preferred = [
    'ggml-large-v3-q5_0.bin',
    'ggml-large-v3.bin',
    'ggml-large-v3-turbo.bin',
    'ggml-large-v3-turbo-q5_0.bin',
    'ggml-medium.bin',
    'ggml-medium-q5_0.bin',
    'ggml-small.bin',
    'ggml-small-q5_1.bin',
  ];
  const found = readdirSafe(dir).filter((entry) => entry.startsWith('ggml-') && entry.endsWith('.bin'));
  const ranked = preferred.filter((entry) => found.includes(entry));
  const rest = found.filter((entry) => !ranked.includes(entry)).sort();
  return [...ranked, ...rest].map((entry) => join(dir, entry));
}

/** @returns candidate ffmpeg binaries: the bundled one, the PATH one, common installs. */
function ffmpegCandidates() {
  const out = [];
  const local = process.env.LOCALAPPDATA;
  if (local) {
    const packages = join(local, 'Microsoft', 'WinGet', 'Packages');
    for (const entry of readdirSafe(packages)) {
      if (!entry.toLowerCase().startsWith('gyan.ffmpeg')) continue;
      const bin = join(packages, entry);
      for (const inner of readdirSafe(bin)) {
        out.push(join(bin, inner, 'bin', 'ffmpeg.exe'));
      }
    }
    out.push(join(local, 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe'));
  }
  out.push('ffmpeg');
  return out;
}

/**
 * Resolve the toolchain once, reporting precisely what is missing.
 * @returns `{ ffmpeg, server, cli, model, error }`
 */
function resolveTools() {
  const ffmpeg = ffmpegCandidates().find((candidate) => candidate === 'ffmpeg' || existsSync(candidate));
  const server = serverCandidates().find((candidate) => existsSync(candidate));
  const cli = cliCandidates().find((candidate) => existsSync(candidate));
  const model = modelCandidates()[0];
  const expected = join(dataDir(), 'whisper');
  let error;
  if (!ffmpeg) error = 'ffmpeg not found on PATH or in %LOCALAPPDATA%\\Microsoft\\WinGet';
  else if (!server && !cli) error = `whisper-server.exe / whisper-cli.exe not found under ${expected}`;
  else if (!model) error = `no whisper model found under ${expected}\\models`;
  return { ffmpeg, server, cli, model, error };
}

/** @returns the DirectShow audio capture devices ffmpeg reports. */
function listAudioDevices() {
  const tools = resolveTools();
  const result = spawnSync(tools.ffmpeg || 'ffmpeg', ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'], {
    windowsHide: true,
    encoding: 'utf8',
    timeout: 20_000,
  });
  const text = `${result.stderr ?? ''}\n${result.stdout ?? ''}`;
  const devices = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\[[^\]]*\]\s+"(.+)"\s+\(audio\)\s*$/.exec(line.trim());
    if (match) devices.push(match[1]);
  }
  return devices;
}

/** Base port for the warm whisper.cpp server; the next few ports are tried on conflict. */
const SERVER_PORTS = [8791, 8792, 8793, 8794];
/** How long the warm server may take to load the model before the CLI takes over. */
const SERVER_BOOT_MS = 120_000;

/**
 * Keeps one whisper.cpp server process warm so a clip costs only inference time
 * (a few hundred milliseconds on CUDA) instead of a fresh model load per click.
 */
class Transcriber {
  /** @param tools - resolved toolchain. */
  constructor(tools) {
    this.tools = tools;
    this.child = undefined;
    this.port = undefined;
    this.ready = undefined;
    this.stderr = '';
  }

  /** @returns whether the warm server is answering right now. */
  async ensure() {
    if (!this.tools.server) return false;
    if (!this.ready) this.ready = this.boot();
    return this.ready;
  }

  /** @returns whether a server could be started on any candidate port. */
  async boot() {
    for (const port of SERVER_PORTS) {
      if (await this.listen(port)) {
        this.port = port;
        return true;
      }
    }
    return false;
  }

  /** @param port - port to bind. @returns whether this process came up on it. */
  async listen(port) {
    const args = ['-m', this.tools.model, '-l', 'zh', '-nt', '-bs', '5', '--carry-initial-prompt', '--host', '127.0.0.1', '--port', String(port), '--prompt', ZH_PROMPT];
    const child = spawn(this.tools.server, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      this.stderr = `${this.stderr}${String(chunk)}`.slice(-2000);
    });
    const deadline = Date.now() + SERVER_BOOT_MS;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) return false;
      try {
        const response = await fetch(`http://127.0.0.1:${String(port)}/`, { signal: AbortSignal.timeout(1500) });
        if (response.ok) {
          this.child = child;
          return true;
        }
      } catch {
        // Still loading the model.
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    try {
      child.kill();
    } catch {
      // Already gone.
    }
    return false;
  }

  /**
   * Transcribe one recording, warm server first and CLI as the fallback.
   * @param wavPath - 16 kHz mono WAV on disk.
   * @returns `{ text }` or `{ error }`.
   */
  async run(wavPath) {
    if (await this.ensure()) {
      const text = await this.post(wavPath);
      if (text !== undefined) return { text: simplify(text) };
    }
    const fallback = await transcribeWithCli(this.tools, wavPath);
    return fallback.text === undefined ? fallback : { text: simplify(fallback.text) };
  }

  /** @param wavPath - file to upload. @returns server text, or undefined on failure. */
  async post(wavPath) {
    try {
      const form = new FormData();
      form.append('file', new Blob([readFileSync(wavPath)], { type: 'audio/wav' }), 'clip.wav');
      form.append('response_format', 'json');
      const response = await fetch(`http://127.0.0.1:${String(this.port)}/inference`, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
      });
      if (!response.ok) return undefined;
      const payload = await response.json();
      return typeof payload?.text === 'string' ? payload.text : undefined;
    } catch {
      return undefined;
    }
  }

  /** Drop the warm server; the next session boots a new one. */
  dispose() {
    const child = this.child;
    this.child = undefined;
    this.ready = undefined;
    this.port = undefined;
    if (!child) return;
    try {
      child.kill();
    } catch {
      // Already gone.
    }
  }
}

/**
 * One-shot transcription through whisper-cli, used when no warm server is around.
 * @param tools - resolved toolchain. @param wavPath - recording to transcribe.
 * @returns `{ text }` or `{ error }`.
 */
async function transcribeWithCli(tools, wavPath) {
  const args = [
    '-m', tools.model, '-l', 'zh', '-f', wavPath, '-nt', '-np', '-bs', '5', '--carry-initial-prompt',
    '-t', String(Math.max(4, Math.min(8, Math.floor((process.env.NUMBER_OF_PROCESSORS ?? '8') / 2) || 4))),
    '--prompt', ZH_PROMPT,
  ];
  return new Promise((resolve) => {
    const child = spawn(tools.cli, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const guard = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // Already gone.
      }
      resolve({ error: 'transcription timed out' });
    }, TRANSCRIBE_TIMEOUT_MS);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      out += chunk;
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      err += chunk;
    });
    child.on('error', (error) => {
      clearTimeout(guard);
      resolve({ error: `whisper-cli failed to start: ${error.message}` });
    });
    child.on('exit', (code) => {
      clearTimeout(guard);
      if (code === 0) resolve({ text: out });
      else resolve({ error: `whisper-cli exited with code ${String(code)}: ${err.trim().split(/\r?\n/).slice(-2).join(' ').slice(0, 300)}` });
    });
  });
}

/**
 * Spawn ffmpeg recording the DirectShow device into a 16 kHz mono WAV.
 * No audio filters here: loudness normalisation runs after the clip is closed,
 * because a streaming filter ramps its gain up and eats the first syllable.
 * @param tools - resolved toolchain. @param device - capture device name.
 * @param wavPath - output file.
 * @returns the ffmpeg child process.
 */
function spawnCapture(tools, device, wavPath) {
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'dshow',
    '-i',
    `audio=${device}`,
    '-ac',
    '1',
    '-ar',
    '16000',
    '-acodec',
    'pcm_s16le',
    // ffmpeg keeps the WAV buffered while recording, so the only reliable
    // "audio is really flowing" signal is its progress report.
    '-progress',
    'pipe:1',
    '-nostats',
    '-y',
    wavPath,
  ];
  return spawn(tools.ffmpeg, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
}

/**
 * One record-then-transcribe session.
 */
class VoiceSession {
  /**
   * @param tools - resolved toolchain.
   * @param device - DirectShow audio device name.
   * @param transcriber - warm whisper.cpp server wrapper.
   * @param adopted - capture already running from a hover prime, if any.
   */
  constructor(tools, device, transcriber, adopted) {
    this.tools = tools;
    this.device = device;
    this.transcriber = transcriber;
    this.adopted = adopted;
    this.events = [];
    this.seq = 0;
    this.status = 'starting';
    this.error = undefined;
    this.recorder = undefined;
    this.wav = adopted?.wav ?? join(dataDir(), `rec-${String(Date.now())}.wav`);
    this.stopped = false;
    this.timer = setTimeout(() => this.cancel('timeout'), MAX_SESSION_MS);
    this.timer.unref?.();
  }

  /** @param event - one event, appended for polling readers. */
  push(event) {
    this.events.push({ seq: ++this.seq, ...event });
    if (this.events.length > 400) this.events.splice(0, this.events.length - 400);
    if (event.type === 'error') {
      this.error = event.message;
      this.status = 'error';
    }
    if (event.type === 'ended') this.status = 'ended';
  }

  /**
   * Start capturing the microphone and wait until samples really flow, so the
   * page only turns red once the first syllable can no longer be dropped.
   * @returns a promise settled when the capture is live (or has failed).
   */
  async start() {
    const child = this.adopted?.child ?? spawnCapture(this.tools, this.device, this.wav);
    this.live = this.adopted?.live === true;
    this.adopted = undefined;
    this.recorder = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      // `out_time_us=…` shows up once ffmpeg has encoded real samples.
      if (/out_time_(?:us|ms)=(?!0$)\d+/m.test(String(chunk))) this.live = true;
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      const text = String(chunk).trim();
      if (text) this.push({ type: 'log', text: text.slice(0, 300) });
    });
    child.on('error', (error) => {
      this.push({ type: 'error', message: `recorder failed to start: ${error.message}` });
      this.finish('error');
    });
    child.on('exit', (code) => {
      if (this.recorder !== child) return;
      this.recorder = undefined;
      if (this.status === 'starting') {
        this.push({ type: 'error', message: `recorder exited early (code ${String(code)})` });
        this.finish('error');
        return;
      }
      if (!this.stopped && this.status !== 'ended') {
        this.push({ type: 'error', message: `recorder stopped unexpectedly (code ${String(code)})` });
        this.finish('error');
        return;
      }
      void this.transcribe();
    });

    await this.awaitLive();
    if (this.status !== 'starting') return;
    this.status = 'recording';
    this.push({ type: 'ready', source: `ffmpeg dshow ${this.device}`, engine: 'whisper.cpp' });
  }

  /** @returns a promise settled once ffmpeg reports real samples, or the wait times out. */
  async awaitLive() {
    const deadline = Date.now() + LIVE_WAIT_MS;
    while (Date.now() < deadline) {
      if (this.status === 'error') return;
      if (this.live) return;
      try {
        // The progress report is the primary signal; a fat WAV is a fallback.
        if (statSync(this.wav).size >= LIVE_BYTES) return;
      } catch {
        // The file appears a moment after the process starts.
      }
      await delay(60);
    }
  }

  /** Ask ffmpeg to finish the file, then transcribe it. */
  stop() {
    if (this.stopped) return;
    this.stopped = true;
    const child = this.recorder;
    if (!child) {
      void this.transcribe();
      return;
    }
    this.status = 'transcribing';
    // Keep capturing briefly: the click usually lands on the last syllable.
    setTimeout(() => {
      try {
        child.stdin.write('q');
      } catch {
        // Fall back to killing it below.
      }
    }, TAIL_MS).unref?.();
    const guard = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // Already gone.
      }
    }, STOP_GRACE_MS);
    guard.unref?.();
    child.once('exit', () => clearTimeout(guard));
  }

  /** Abort the session without producing text. @param reason - recorded on the session. */
  cancel(reason) {
    clearTimeout(this.timer);
    this.stopped = true;
    const child = this.recorder;
    this.recorder = undefined;
    if (child) {
      try {
        child.kill();
      } catch {
        // Already gone.
      }
    }
    this.dropWav();
    this.push({ type: 'ended', reason });
    this.status = 'ended';
  }

  /** Remove the temporary recording, ignoring failures. */
  dropWav() {
    try {
      rmSync(this.wav, { force: true });
    } catch {
      // A locked file is harmless: the next session writes a new name.
    }
  }

  /**
   * Apply band-pass and loudness normalisation to the finished clip. Doing it
   * after the file is closed keeps the gain flat from the first syllable on.
   * @returns the normalised file, or the raw recording when ffmpeg fails.
   */
  normalize() {
    const out = join(dataDir(), `norm-${String(Date.now())}.wav`);
    const probe = spawnSync(this.tools.ffmpeg, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      this.wav,
      '-af',
      'highpass=f=80,dynaudnorm=f=300:g=15:p=0.9:m=20',
      '-ac',
      '1',
      '-ar',
      '16000',
      '-acodec',
      'pcm_s16le',
      out,
    ], { windowsHide: true, timeout: 30_000 });
    if (probe.status === 0 && existsSync(out) && statSync(out).size > 1_000) return out;
    rmSync(out, { force: true });
    return this.wav;
  }

  /**
   * Run whisper.cpp over the finished recording.
   * @returns a promise settled when the session has produced its final text.
   */
  async transcribe() {
    clearTimeout(this.timer);
    this.status = 'transcribing';
    const wav = this.normalize();
    const result = await this.transcriber.run(wav);

    // Keep the most recent clip so a bad result can be reproduced offline.
    try {
      copyFileSync(wav, join(dataDir(), 'last.wav'));
    } catch {
      // Diagnostics are best-effort.
    }
    if (wav !== this.wav) rmSync(wav, { force: true });
    this.dropWav();
    if (result.error) {
      this.push({ type: 'error', message: result.error });
      this.finish('error');
      return;
    }
    const cleaned = cleanTranscript(result.text ?? '');
    if (!cleaned) {
      this.push({ type: 'error', message: 'no speech detected' });
      this.finish('empty');
      return;
    }
    this.push({ type: 'final', text: cleaned });
    this.finish('ok');
  }

  /** @param reason - why the session ended. */
  finish(reason) {
    this.status = 'ended';
    this.push({ type: 'ended', reason });
  }

  /** @param since - last sequence number the reader already has. @returns the poll payload. */
  snapshot(since) {
    return {
      status: this.status,
      seq: this.seq,
      error: this.error,
      events: this.events.filter((event) => event.seq > since),
    };
  }
}

/**
 * Turn whisper's raw stdout into one clean sentence.
 * @param raw - stdout of whisper-cli.
 * @returns the transcript, empty when nothing usable came back.
 */
function cleanTranscript(raw) {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\[[^\]]*\]\s*/, '').trim())
    .filter((line) => line && !/^\[BLANK_AUDIO\]$/i.test(line) && !/^\(?\s*(silence|music|applause)\s*\)?$/i.test(line));
  const joined = lines.join('').replace(/\s+/g, ' ').trim();
  // Silence often comes back as a lone full stop or a bracket note; require at
  // least one letter or digit before treating it as speech.
  if (!/[\p{L}\p{N}]/u.test(joined)) return '';
  return joined;
}

/** @param res - response to answer. @param status - HTTP status. @param payload - JSON body. */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * Host activation: own the recording session and its routes.
 * @param ctx - host context. @param config - bundle configuration (`audioDevice`).
 */
export function apply(ctx, config) {
  const state = { session: null, tools: undefined, toolsError: undefined, pings: [], devices: [], transcriber: undefined,
    prime: undefined, primeTimer: undefined };

  /** Stop and delete the hover-primed capture, if one is waiting. */
  const dropPrime = () => {
    clearTimeout(state.primeTimer);
    state.primeTimer = undefined;
    const prime = state.prime;
    state.prime = undefined;
    if (!prime) return;
    try {
      prime.child.stdin.write('q');
    } catch {
      try {
        prime.child.kill();
      } catch {
        // Already gone.
      }
    }
    setTimeout(() => rmSync(prime.wav, { force: true }), 2_000).unref?.();
  };

  /**
   * Prime the microphone while the pointer hovers the button: ffmpeg needs
   * ~1 s to open a DirectShow device, and paying that before the click means
   * the first word is never clipped.
   */
  const startPrime = () => {
    const resolved = tools();
    if (!resolved) return;
    if (state.session && state.session.status !== 'ended' && state.session.status !== 'error') return;
    if (state.prime) return;
    const wav = join(dataDir(), `prime-${String(Date.now())}.wav`);
    const child = spawnCapture(resolved, device(), wav);
    const entry = { child, wav, live: false };
    state.prime = entry;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (/out_time_(?:us|ms)=(?!0$)\d+/m.test(String(chunk))) entry.live = true;
    });
    child.on('error', () => dropPrime());
    state.primeTimer = setTimeout(dropPrime, PREWARM_TTL_MS);
    state.primeTimer.unref?.();
  };

  /** Resolve the toolchain on first use so activation never blocks on disk I/O. */
  const tools = () => {
    if (state.tools || state.toolsError) return state.tools;
    const resolved = resolveTools();
    if (resolved.error) state.toolsError = resolved.error;
    else state.tools = resolved;
    return state.tools;
  };

  /** @returns the shared warm transcriber, created on first use. */
  const transcriber = () => {
    const resolved = tools();
    if (!resolved) return undefined;
    if (!state.transcriber) state.transcriber = new Transcriber(resolved);
    return state.transcriber;
  };

  /** @returns the configured or first DirectShow capture device. */
  const device = () => {
    if (typeof config?.audioDevice === 'string' && config.audioDevice.trim()) return config.audioDevice.trim();
    if (!state.devices.length) {
      try {
        state.devices = listAudioDevices();
      } catch {
        state.devices = [];
      }
    }
    return state.devices[0] ?? 'default';
  };

  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'prefix',
      path: ROUTE,
      handler: (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const action = url.pathname.slice(ROUTE.length).replace(/^\/+/, '');

        if (action === 'status') {
          const resolved = tools();
          sendJson(res, 200, {
            ok: !state.toolsError,
            engine: resolved ? 'whisper.cpp' : null,
            warm: Boolean(state.transcriber?.port),
            gpu: resolved?.server ? 'cuda-or-cpu' : 'cpu-cli',
            model: resolved?.model,
            device: resolved ? device() : undefined,
            devices: state.devices,
            error: state.toolsError,
            pings: state.pings,
            primed: Boolean(state.prime),
            session: state.session ? state.session.snapshot(0) : null,
          });
          return;
        }

        if (action === 'ping') {
          state.pings.push({ phase: url.searchParams.get('phase') ?? '', at: Date.now() });
          if (state.pings.length > 20) state.pings.splice(0, state.pings.length - 20);
          sendJson(res, 200, { ok: true });
          return;
        }

        if (action === 'warm') {
          startPrime();
          sendJson(res, 200, { ok: true, primed: Boolean(state.prime) });
          return;
        }

        if (action === 'start') {
          const resolved = tools();
          if (!resolved) {
            sendJson(res, 503, { ok: false, error: state.toolsError ?? 'toolchain unavailable' });
            return;
          }
          if (state.session && state.session.status !== 'ended' && state.session.status !== 'error') state.session.cancel('restart');
          // Hand the hover-primed capture to the session so the click never
          // costs the ffmpeg start-up delay.
          clearTimeout(state.primeTimer);
          state.primeTimer = undefined;
          const adopted = state.prime;
          state.prime = undefined;
          const session = new VoiceSession(resolved, device(), transcriber(), adopted);
          state.session = session;
          void session.start();
          sendJson(res, 200, { ok: true, primed: Boolean(adopted) });
          return;
        }

        if (action === 'events') {
          const since = Number(url.searchParams.get('since') ?? '0');
          const session = state.session;
          if (!session) {
            sendJson(res, 200, { status: 'idle', seq: 0, events: [] });
            return;
          }
          sendJson(res, 200, session.snapshot(Number.isFinite(since) ? since : 0));
          return;
        }

        if (action === 'stop') {
          state.session?.stop();
          sendJson(res, 200, { ok: true });
          return;
        }

        if (action === 'cancel') {
          state.session?.cancel('user');
          sendJson(res, 200, { ok: true });
          return;
        }

        sendJson(res, 404, { ok: false, error: 'unknown action' });
      },
    });
    // Load the model into memory right away so the first click is already fast.
    const prewarm = setTimeout(() => {
      void transcriber()?.ensure().catch(() => {});
    }, 1_500);
    prewarm.unref?.();
    return () => {
      clearTimeout(prewarm);
      state.session?.cancel('dispose');
      dropPrime();
      state.transcriber?.dispose();
      dispose();
    };
  }, 'voice-widget: routes');
}

export { inject, name, ROUTE };
