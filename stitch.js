#!/usr/bin/env node

const { execFile, execFileSync, spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

let blessed;
try {
  blessed = require("neo-blessed");
} catch {
  // TUI unavailable — will fall back to legacy mode
}

const VIDEO_EXTENSIONS = new Set([
  ".mp4",
  ".mkv",
  ".avi",
  ".mov",
  ".wmv",
  ".flv",
  ".webm",
  ".m4v",
  ".mpg",
  ".mpeg",
  ".ts",
  ".mts",
]);

const BATCH_SIZE = 50;
// ~15 min per batch at CRF 18 1080p60 stays safely under 4GB FAT32 limit
const FAT_MAX_BATCH_SECS = 900;

// ── Argument parsing ────────────────────────────────────────────

function usage() {
  console.error(
    "Usage: node stitch.js <input-folder> [output-file] [--bgm <audio-file>] [--no-tui] [--glitch] [--fast] [--temp-dir <path>]\n" +
      "  input-folder  Directory containing video files\n" +
      "  output-file   Output filename (default: output.mp4)\n" +
      "  --bgm         Path to background music file (lowers gameplay audio to 75%)\n" +
      "  --no-tui      Disable the progress UI (plain ffmpeg output)\n" +
      "  --glitch      Detect corrupted frames and overlay purple GLITCH text\n" +
      "  --temp-dir    Custom directory for temporary batch files (default: OS temp)\n" +
      "  --no-delete-temp  Keep temporary batch files after completion\n" +
      "  --from <n>    Start from the nth file (1-based)\n" +
      "  --to <n>      End at the nth file (1-based, inclusive)\n" +
      "  --fat-mode    Limit batch temp files to <4GB for FAT32 filesystems\n" +
      "  -r, --recursive  Scan subdirectories for video files\n" +
      "  --fast        Encode ~3x faster (x264 veryfast preset, near-identical quality)"
  );
  process.exit(1);
}

function expandTilde(p) {
  if (p.startsWith("~/") || p === "~") {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

function parseArgs(argv) {
  const positional = [];
  let bgmPath = null;
  let noTui = false;
  let glitch = false;
  let tempDir = null;
  let noDeleteTemp = false;
  let fromIdx = null;
  let toIdx = null;
  let fatMode = false;
  let recursive = false;
  let fast = false;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--bgm") {
      i++;
      if (i >= argv.length) {
        console.error("Error: --bgm requires a path to an audio file.");
        process.exit(1);
      }
      bgmPath = path.resolve(expandTilde(argv[i]));
    } else if (argv[i] === "--no-tui") {
      noTui = true;
    } else if (argv[i] === "--glitch") {
      glitch = true;
    } else if (argv[i] === "--no-delete-temp") {
      noDeleteTemp = true;
    } else if (argv[i] === "--from") {
      i++;
      if (i >= argv.length) {
        console.error("Error: --from requires an integer.");
        process.exit(1);
      }
      fromIdx = Number(argv[i]);
      if (!Number.isInteger(fromIdx)) {
        console.error("Error: --from requires an integer.");
        process.exit(1);
      }
    } else if (argv[i] === "--to") {
      i++;
      if (i >= argv.length) {
        console.error("Error: --to requires an integer.");
        process.exit(1);
      }
      toIdx = Number(argv[i]);
      if (!Number.isInteger(toIdx)) {
        console.error("Error: --to requires an integer.");
        process.exit(1);
      }
    } else if (argv[i] === "--fat-mode") {
      fatMode = true;
    } else if (argv[i] === "--fast") {
      fast = true;
    } else if (argv[i] === "-r" || argv[i] === "--recursive") {
      recursive = true;
    } else if (argv[i] === "--temp-dir") {
      i++;
      if (i >= argv.length) {
        console.error("Error: --temp-dir requires a path.");
        process.exit(1);
      }
      tempDir = path.resolve(expandTilde(argv[i]));
    } else {
      positional.push(argv[i]);
    }
  }

  if (positional.length < 1) usage();

  return {
    inputFolder: path.resolve(expandTilde(positional[0])),
    outputFile: path.resolve(expandTilde(positional[1] || "output.mp4")),
    bgmPath,
    noTui,
    glitch,
    tempDir,
    noDeleteTemp,
    fromIdx,
    toIdx,
    fatMode,
    recursive,
    fast,
  };
}

// ── File scanning ───────────────────────────────────────────────

function collectVideoFiles(dir, recursive) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    // Skip hidden entries: macOS AppleDouble "._*" sidecars on FAT/exFAT
    // drives, plus .Trashes, .Spotlight-V100, etc.
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (recursive) out.push(...collectVideoFiles(full, recursive));
    } else if (
      entry.isFile() &&
      VIDEO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())
    ) {
      out.push(full);
    }
  }
  return out;
}

// ── ffprobe helpers ─────────────────────────────────────────────

// Shell-free execution: filenames with quotes, spaces, or "$()" must not
// reach a shell.
function ffprobeJson(args) {
  return new Promise((resolve, reject) => {
    execFile(
      "ffprobe",
      ["-v", "quiet", "-print_format", "json", ...args],
      { encoding: "utf-8", maxBuffer: 32 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return reject(err);
        try {
          resolve(JSON.parse(stdout));
        } catch (parseErr) {
          reject(parseErr);
        }
      }
    );
  });
}

// One ffprobe call per file: format duration plus first video stream params.
async function probeVideoInfo(filePath) {
  const data = await ffprobeJson([
    "-show_format",
    "-show_streams",
    "-select_streams",
    "v:0",
    filePath,
  ]);
  const stream = data.streams && data.streams[0];
  if (!stream) throw new Error(`No video stream found in ${filePath}`);

  let duration = parseFloat(data.format?.duration);
  if (!(duration > 0)) {
    // Recordings that were cut off (crash, disk full) never get the MKV
    // duration header written. Fall back to the last video packet's timestamp.
    duration = await getDurationFromPackets(filePath);
  }

  let fps = 30;
  if (stream.r_frame_rate) {
    const [num, den] = stream.r_frame_rate.split("/").map(Number);
    if (den > 0) fps = num / den;
  }
  return { width: stream.width, height: stream.height, fps, duration };
}

async function getDurationFromPackets(filePath) {
  try {
    const out = await new Promise((resolve, reject) => {
      execFile(
        "ffprobe",
        [
          "-v", "quiet",
          "-select_streams", "v:0",
          "-show_entries", "packet=pts_time",
          "-of", "csv=p=0",
          filePath,
        ],
        { encoding: "utf-8", maxBuffer: 256 * 1024 * 1024 },
        (err, stdout) => (err ? reject(err) : resolve(stdout))
      );
    });
    let max = 0;
    for (const line of out.split("\n")) {
      const t = parseFloat(line);
      if (t > max) max = t;
    }
    return max;
  } catch {
    return 0;
  }
}

// Probes every file in parallel (a small pool of ffprobe workers) and splits
// the results into valid files and corrupted/unreadable skips, preserving the
// original sort order.
async function probeFiles(selectedFiles) {
  const results = new Array(selectedFiles.length).fill(null);
  const concurrency = Math.min(os.cpus().length, 8);
  let idx = 0;
  let completed = 0;

  async function probeOne(i) {
    const f = selectedFiles[i];
    const name = path.basename(f);
    let dur = 0;
    let info = null;
    try {
      info = await probeVideoInfo(f);
      dur = info.duration;
    } catch {
      // probe failed — file is unreadable
    }
    completed++;
    const pct = Math.round((completed / selectedFiles.length) * 100);
    const status =
      info && dur > 0
        ? `${formatTime(dur)} (${dur.toFixed(2)}s)`
        : "SKIPPED (corrupted or unreadable)";
    if (process.stderr.isTTY) {
      process.stderr.clearLine(0);
      process.stderr.cursorTo(0);
      process.stderr.write(
        `  ${String(pct).padStart(3)}% [${completed}/${selectedFiles.length}] ${name} → ${status}`
      );
    } else {
      console.error(
        `  ${String(pct).padStart(3)}% [${completed}/${selectedFiles.length}] ${name} → ${status}`
      );
    }
    results[i] = { file: f, dur, info };
  }

  async function worker() {
    while (idx < selectedFiles.length) {
      const i = idx++;
      await probeOne(i);
    }
  }

  const workers = [];
  for (let i = 0; i < Math.min(concurrency, selectedFiles.length); i++) {
    workers.push(worker());
  }
  await Promise.all(workers);

  if (process.stderr.isTTY) {
    process.stderr.clearLine(0);
    process.stderr.cursorTo(0);
  }

  const validFiles = [];
  const durations = [];
  const infos = [];
  const skipped = [];
  for (const r of results) {
    if (!r) continue;
    if (!r.info || r.dur <= 0) {
      skipped.push(path.basename(r.file));
    } else {
      validFiles.push(r.file);
      durations.push(r.dur);
      infos.push(r.info);
    }
  }
  return { validFiles, durations, infos, skipped };
}

// ── Formatting helpers ──────────────────────────────────────────

function formatTime(seconds) {
  if (!isFinite(seconds) || seconds < 0) return "--:--";
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0)
    return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

function makeBar(fraction, width) {
  const clamped = Math.max(0, Math.min(1, fraction));
  const filled = Math.round(clamped * width);
  const empty = width - filled;
  return "\u2588".repeat(filled) + "\u2591".repeat(empty);
}

function makeBarColored(fraction, width, color) {
  const clamped = Math.max(0, Math.min(1, fraction));
  const filled = Math.round(clamped * width);
  const empty = width - filled;
  return (
    `{${color}-fg}` +
    "\u2588".repeat(filled) +
    `{/${color}-fg}{white-fg}` +
    "\u2591".repeat(empty) +
    "{/white-fg}"
  );
}

// ── Build ffmpeg filter / args ──────────────────────────────────

function buildFFmpegArgs(files, width, height, fps, bgmPath, outputFile, glitchSet, preset = "medium") {
  const inputArgs = [];
  const videoFilters = [];
  const audioFilters = [];
  const bgmIndex = bgmPath ? files.length : null;

  files.forEach((file, i) => {
    inputArgs.push("-i", file);
    const filename = path.basename(file).replace(/'/g, "'\\''");
    const fontSize = Math.max(16, Math.round(height / 25));
    let vf =
      `[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
        `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,` +
        `setsar=1,format=yuv420p,fps=${fps},` +
        `drawtext=text='${filename}':fontsize=${fontSize}:` +
        `fontcolor=white@0.3:x=(w-tw)/2:y=h-th-20`;

    if (glitchSet && glitchSet.has(file)) {
      const glitchFontSize = Math.max(24, Math.round(height / 18));
      vf += `,drawtext=text='GLITCH':fontsize=${glitchFontSize}:` +
        `fontcolor=#AA00FF@0.85:x=w-tw-20:y=20`;
    }

    vf += `[v${i}]`;
    videoFilters.push(vf);
    // Normalize audio: consistent sample rate, sample format, and channel layout
    // so the concat filter doesn't produce drift or glitches between segments
    audioFilters.push(
      `[${i}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`
    );
  });

  // Use -stream_loop for seamless BGM looping (demuxer-level, no filter glitches)
  if (bgmPath) inputArgs.push("-stream_loop", "-1", "-i", bgmPath);

  const allFilters = [...videoFilters, ...audioFilters].join("; ");

  // Concat video AND audio together per-segment to maintain sync
  const concatInputs = files.map((_, i) => `[v${i}][a${i}]`).join("");

  let filterWithAudio;
  if (bgmPath) {
    filterWithAudio =
      allFilters +
      `; ${concatInputs}concat=n=${files.length}:v=1:a=1[outv][gamea]` +
      `; [gamea]volume=0.75[gamevol]` +
      `; [${bgmIndex}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[bgmnorm]` +
      `; [gamevol][bgmnorm]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[outa]`;
  } else {
    filterWithAudio =
      allFilters +
      `; ${concatInputs}concat=n=${files.length}:v=1:a=1[outv][outa]`;
  }

  // Video-only fallback (no audio processing)
  const videoOnlyConcatInputs = files.map((_, i) => `[v${i}]`).join("");
  const filterVideoOnly =
    videoFilters.join("; ") +
    `; ${videoOnlyConcatInputs}concat=n=${files.length}:v=1:a=0[outv]`;

  const commonTail = [
    "-c:v",
    "libx264",
    "-preset",
    preset,
    "-crf",
    "18",
    "-movflags",
    "+faststart",
    "-y",
    outputFile,
  ];

  const withAudioArgs = [
    ...inputArgs,
    "-filter_complex",
    filterWithAudio,
    "-map",
    "[outv]",
    "-map",
    "[outa]",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    ...commonTail,
  ];

  const videoOnlyArgs = [
    ...inputArgs,
    "-filter_complex",
    filterVideoOnly,
    "-map",
    "[outv]",
    "-an",
    ...commonTail,
  ];

  return { withAudioArgs, videoOnlyArgs };
}

// ── Batch processing helpers ─────────────────────────────────────

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

function chunkByDuration(files, durations, maxSecs, maxFiles) {
  const batches = [];
  const batchDurations = [];
  let curFiles = [];
  let curDurs = [];
  let curTotal = 0;

  for (let i = 0; i < files.length; i++) {
    if (curFiles.length > 0 && (curTotal + durations[i] > maxSecs || curFiles.length >= maxFiles)) {
      batches.push(curFiles);
      batchDurations.push(curDurs);
      curFiles = [];
      curDurs = [];
      curTotal = 0;
    }
    curFiles.push(files[i]);
    curDurs.push(durations[i]);
    curTotal += durations[i];
  }

  if (curFiles.length > 0) {
    batches.push(curFiles);
    batchDurations.push(curDurs);
  }

  return { batches, batchDurations };
}

function writeConcatList(files, listPath) {
  const content = files
    .map((f) => `file '${f.replace(/'/g, "'\\''")}'`)
    .join("\n");
  fs.writeFileSync(listPath, content);
}

function buildConcatArgs(concatListPath, bgmPath, outputFile) {
  if (bgmPath) {
    return [
      "-f", "concat", "-safe", "0", "-i", concatListPath,
      "-stream_loop", "-1", "-i", bgmPath,
      "-c:v", "copy",
      "-filter_complex",
      "[0:a]volume=0.75[gamevol];" +
        "[1:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[bgmnorm];" +
        "[gamevol][bgmnorm]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[outa]",
      "-map", "0:v", "-map", "[outa]",
      "-c:a", "aac", "-b:a", "192k",
      "-movflags", "+faststart",
      "-y", outputFile,
    ];
  }
  return [
    "-f", "concat", "-safe", "0", "-i", concatListPath,
    "-c", "copy",
    "-movflags", "+faststart",
    "-y", outputFile,
  ];
}

// ── Glitch detection ─────────────────────────────────────────────

async function detectGlitchFiles(files) {
  const glitchSet = new Set();
  const concurrency = Math.min(os.cpus().length, 8);
  let completed = 0;
  let idx = 0;

  function checkFile(filePath) {
    return new Promise((resolve) => {
      const proc = spawn("ffmpeg", [
        "-v", "error", "-nostdin", "-i", filePath, "-f", "null", "-",
      ], { stdio: ["ignore", "ignore", "pipe"] });

      let stderr = "";
      proc.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
      proc.on("close", () => {
        completed++;
        const hasErrors = stderr.trim().length > 0;
        if (hasErrors) glitchSet.add(filePath);

        const name = path.basename(filePath);
        const pct = Math.round((completed / files.length) * 100);
        const status = hasErrors ? "GLITCH" : "OK";
        if (process.stderr.isTTY) {
          process.stderr.clearLine(0);
          process.stderr.cursorTo(0);
          process.stderr.write(`  ${String(pct).padStart(3)}% [${completed}/${files.length}] ${name} → ${status}`);
        } else if (hasErrors) {
          console.error(`  ${name} → GLITCH`);
        }
        resolve();
      });
    });
  }

  async function worker() {
    while (idx < files.length) {
      const i = idx++;
      await checkFile(files[i]);
    }
  }

  const workers = [];
  for (let i = 0; i < Math.min(concurrency, files.length); i++) {
    workers.push(worker());
  }
  await Promise.all(workers);

  if (process.stderr.isTTY) {
    process.stderr.clearLine(0);
    process.stderr.cursorTo(0);
  }

  return glitchSet;
}

function runFFmpegInherit(args) {
  return new Promise((resolve) => {
    const proc = spawn("ffmpeg", ["-nostdin", ...args], {
      stdio: "inherit",
    });
    proc.on("close", (code) => resolve(code));
  });
}

// ── TUI ─────────────────────────────────────────────────────────

function createUI() {
  // neo-blessed's terminfo compiler crashes on the Setulc capability
  // (extended underline colors) present in modern terminal definitions.
  // Suppress stderr during init and retry with a simpler TERM if needed.
  const origStderrWrite = process.stderr.write;
  process.stderr.write = () => true;

  let screen;
  try {
    screen = blessed.screen({
      smartCSR: true,
      title: "vidstitch",
      fullUnicode: true,
    });
  } catch {
    process.env.TERM = "xterm";
    screen = blessed.screen({
      smartCSR: true,
      title: "vidstitch",
      fullUnicode: true,
    });
  } finally {
    process.stderr.write = origStderrWrite;
  }

  const logBox = blessed.log({
    top: 0,
    left: 0,
    width: "100%",
    height: "100%-8",
    border: { type: "line" },
    label: " {blue-fg}ffmpeg output{/blue-fg} ",
    tags: true,
    scrollable: true,
    alwaysScroll: true,
    scrollbar: { ch: "\u2588", style: { fg: "blue" } },
    mouse: true,
    keys: true,
    vi: true,
    style: {
      border: { fg: "blue" },
    },
  });

  const progressBox = blessed.box({
    bottom: 0,
    left: 0,
    width: "100%",
    height: 8,
    border: { type: "line" },
    label: " {green-fg}Progress{/green-fg} ",
    tags: true,
    style: {
      border: { fg: "green" },
    },
  });

  screen.append(logBox);
  screen.append(progressBox);

  screen.key(["q", "C-c"], () => {
    screen.destroy();
    process.exit(0);
  });

  screen.render();

  return { screen, logBox, progressBox };
}

function runFFmpegTUI(screen, logBox, progressBox, ffmpegArgs, files, durations, totalDuration, globalCtx) {
  return new Promise((resolve) => {
    // Cumulative durations for file-index tracking
    const cumDurations = [];
    let cumSum = 0;
    for (const d of durations) {
      cumDurations.push(cumSum);
      cumSum += d;
    }

    const startTime = Date.now();
    let progressBuffer = "";
    let lastStats = {};

    // Spawn ffmpeg with progress pipe on stdout, log on stderr
    const args = ["-nostdin", "-nostats", "-progress", "pipe:1", ...ffmpegArgs];
    const proc = spawn("ffmpeg", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Let q / ctrl-c kill the process
    const killHandler = () => {
      proc.kill("SIGTERM");
      screen.destroy();
      process.exit(1);
    };
    screen.unkey(["q", "C-c"]);
    screen.key(["q", "C-c"], killHandler);

    // ── stderr → log box ──
    let stderrBuf = "";
    proc.stderr.on("data", (chunk) => {
      stderrBuf += chunk.toString();
      const lines = stderrBuf.split(/\r?\n|\r/);
      stderrBuf = lines.pop(); // keep incomplete tail
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) logBox.log(trimmed);
      }
      screen.render();
    });
    proc.stderr.on("end", () => {
      if (stderrBuf.trim()) logBox.log(stderrBuf.trim());
    });

    // ── stdout → progress parsing ──
    proc.stdout.on("data", (chunk) => {
      progressBuffer += chunk.toString();

      // Split into complete blocks (each ends with progress=continue or progress=end)
      const parts = progressBuffer.split(/progress=\w+\n/);
      if (parts.length > 1) {
        // All but last are complete blocks
        for (let i = 0; i < parts.length - 1; i++) {
          parseBlock(parts[i]);
        }
        progressBuffer = parts[parts.length - 1];
      }
    });

    function parseBlock(block) {
      const lines = block.split("\n");
      for (const line of lines) {
        const eq = line.indexOf("=");
        if (eq === -1) continue;
        const key = line.substring(0, eq).trim();
        const val = line.substring(eq + 1).trim();
        if (key) lastStats[key] = val;
      }
      updateProgressUI();
    }

    function updateProgressUI() {
      const outTimeUs = parseInt(lastStats.out_time_us, 10) || 0;
      const currentTime = Math.max(0, outTimeUs / 1_000_000);
      const speed = parseFloat(lastStats.speed) || 0;

      // Find current file within this ffmpeg invocation
      let fileIdx = 0;
      for (let i = 0; i < cumDurations.length; i++) {
        if (currentTime >= cumDurations[i]) fileIdx = i;
      }
      const fileStart = cumDurations[fileIdx];
      const fileDur = durations[fileIdx] || 1;
      const fileFraction = (currentTime - fileStart) / fileDur;

      const barWidth = Math.max(10, (screen.width || 80) - 26);
      const fileBar = makeBarColored(fileFraction, barWidth, "yellow");
      const filePct = (Math.min(1, fileFraction) * 100).toFixed(1);
      const fileName = path.basename(files[fileIdx]);
      const speedStr = speed > 0 ? speed.toFixed(2) + "x" : "...";

      if (globalCtx) {
        // Batched mode: unified progress across all batches + concat
        const isConcat = globalCtx.phase === "Stitching";
        const stepNum = isConcat ? 2 : 1;
        const stepLabel = isConcat
          ? "Stitching batches"
          : `Encoding — Batch ${globalCtx.currentBatch + 1}/${globalCtx.totalBatches}`;
        const globalFileIdx = isConcat ? fileIdx : globalCtx.fileOffset + fileIdx;
        const globalFileCount = isConcat ? files.length : globalCtx.totalFiles;
        const fileLabel = isConcat ? "Batch" : "File";

        // Overall fraction: encoding gets encodingWeight, concat gets the rest
        let overallFraction;
        if (isConcat) {
          const concatFraction = totalDuration > 0 ? currentTime / totalDuration : 0;
          overallFraction = globalCtx.encodingWeight + concatFraction * (1 - globalCtx.encodingWeight);
        } else {
          const globalDurationProgress = globalCtx.durationOffset + currentTime;
          overallFraction = (globalDurationProgress / globalCtx.totalDuration) * globalCtx.encodingWeight;
        }

        const totalBar = makeBarColored(overallFraction, barWidth, "green");
        const totalPct = (Math.min(1, overallFraction) * 100).toFixed(1);
        const overallElapsed = (Date.now() - globalCtx.startTime) / 1000;
        const overallEta = overallFraction > 0.001 ? overallElapsed / overallFraction - overallElapsed : 0;

        progressBox.setContent(
          `  {bold}Step ${stepNum}/2: ${stepLabel}{/bold}\n` +
            `  ${fileLabel} ${globalFileIdx + 1}/${globalFileCount}: ${fileName}\n` +
            `  ${fileLabel.padEnd(5)}  ${fileBar}  ${filePct.padStart(5)}%\n` +
            `  Total  ${totalBar}  ${totalPct.padStart(5)}%\n` +
            `\n` +
            `  Elapsed: {cyan-fg}${formatTime(overallElapsed)}{/cyan-fg}` +
            `   Speed: {cyan-fg}${speedStr}{/cyan-fg}` +
            `   ETA: {cyan-fg}${formatTime(overallEta)}{/cyan-fg}`
        );
      } else {
        // Non-batched mode: original display
        const totalFraction = totalDuration > 0 ? currentTime / totalDuration : 0;
        const totalBar = makeBarColored(totalFraction, barWidth, "green");
        const totalPct = (Math.min(1, totalFraction) * 100).toFixed(1);
        const elapsed = (Date.now() - startTime) / 1000;
        const eta = totalFraction > 0.001 ? elapsed / totalFraction - elapsed : 0;

        progressBox.setContent(
          `  {bold}File ${fileIdx + 1}/${files.length}{/bold}: ${fileName}\n` +
            `  File   ${fileBar}  ${filePct.padStart(5)}%\n` +
            `  Total  ${totalBar}  ${totalPct.padStart(5)}%\n` +
            `\n` +
            `  Elapsed: {cyan-fg}${formatTime(elapsed)}{/cyan-fg}` +
            `   Speed: {cyan-fg}${speedStr}{/cyan-fg}` +
            `   ETA: {cyan-fg}${formatTime(eta)}{/cyan-fg}`
        );
      }
      screen.render();
    }

    // Initial state
    progressBox.setContent("  Waiting for ffmpeg to start...");
    screen.render();

    proc.on("close", (code) => {
      // Restore default quit handler
      screen.unkey(["q", "C-c"]);
      screen.key(["q", "C-c"], () => {
        screen.destroy();
        process.exit(0);
      });
      resolve(code);
    });
  });
}

// ── Legacy mode (no TUI) ───────────────────────────────────────

function runLegacy(ffmpegArgs, outputFile, retryArgs) {
  const proc = spawn("ffmpeg", ["-nostdin", ...ffmpegArgs], {
    stdio: "inherit",
  });
  proc.on("close", (code) => {
    if (code === 0) {
      console.log(`\nDone! Output saved to ${outputFile}`);
      return;
    }
    if (!retryArgs) {
      console.error(`\nffmpeg exited with code ${code}`);
      process.exit(code);
    }
    console.log("\nRetrying without audio...");
    const proc2 = spawn("ffmpeg", ["-nostdin", ...retryArgs], {
      stdio: "inherit",
    });
    proc2.on("close", (code2) => {
      if (code2 === 0) {
        console.log(`\nDone! Output saved to ${outputFile} (video only)`);
      } else {
        console.error(`\nffmpeg exited with code ${code2}`);
        process.exit(code2);
      }
    });
  });
}

// ── Batched processing ──────────────────────────────────────────

async function processBatched({ validFiles, durations, width, height, fps, bgmPath, outputFile, totalDuration, skipped, useTui, glitchSet, tempDir, noDeleteTemp, fatMode, preset }) {
  let tmpDir;
  if (tempDir) {
    fs.mkdirSync(tempDir, { recursive: true });
    tmpDir = tempDir;
  } else {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vidstitch-"));
  }

  try {
    let batches, batchDurations;
    if (fatMode) {
      ({ batches, batchDurations } = chunkByDuration(validFiles, durations, FAT_MAX_BATCH_SECS, BATCH_SIZE));
    } else {
      batches = chunkArray(validFiles, BATCH_SIZE);
      batchDurations = chunkArray(durations, BATCH_SIZE);
    }
    let intermediates = [];
    let audioFailed = false;

    let screen, logBox, progressBox;
    if (useTui) {
      ({ screen, logBox, progressBox } = createUI());
    }

    const log = useTui
      ? (msg) => { logBox.log(msg); screen.render(); }
      : (msg) => console.log(msg.replace(/\{[^}]*\}/g, ""));

    log(`Processing ${validFiles.length} files in ${batches.length} batch(es)...`);
    log(`Target: ${width}x${height} @ ${fps.toFixed(2)} fps`);
    log(`Total duration: ${formatTime(totalDuration)}`);
    if (bgmPath) log(`BGM: ${path.basename(bgmPath)} (applied in final step)`);
    log("");

    if (glitchSet && glitchSet.size > 0) {
      log(`{magenta-fg}${glitchSet.size} file(s) with corrupted frames (GLITCH overlay applied){/magenta-fg}`);
    }

    if (skipped.length > 0) {
      log(`{yellow-fg}Skipped ${skipped.length} corrupted file(s):{/yellow-fg}`);
      skipped.forEach((name) => log(`  {yellow-fg}- ${name}{/yellow-fg}`));
    }
    log("");

    // Global progress context for unified tracking across all batches + concat
    const globalCtx = useTui ? {
      startTime: Date.now(),
      totalFiles: validFiles.length,
      fileOffset: 0,
      totalDuration,
      durationOffset: 0,
      totalBatches: batches.length,
      currentBatch: 0,
      phase: "Encoding",
      encodingWeight: 0.97,
    } : null;

    // Phase 1: Process batches with audio
    for (let b = 0; b < batches.length; b++) {
      const batch = batches[b];
      const batchDurs = batchDurations[b];
      const batchTotal = batchDurs.reduce((a, c) => a + c, 0);
      const batchOutput = path.join(tmpDir, `batch_${b}.mp4`);

      log(`{bold}Batch ${b + 1}/${batches.length}{/bold} (${batch.length} files, ${formatTime(batchTotal)})...`);

      const { withAudioArgs } = buildFFmpegArgs(batch, width, height, fps, null, batchOutput, glitchSet, preset);

      let code;
      if (useTui) {
        code = await runFFmpegTUI(screen, logBox, progressBox, withAudioArgs, batch, batchDurs, batchTotal, globalCtx);
      } else {
        code = await runFFmpegInherit(withAudioArgs);
      }

      if (code !== 0) {
        log("{yellow-fg}Audio encoding failed. Will retry all batches without audio...{/yellow-fg}");
        audioFailed = true;
        break;
      }
      intermediates.push(batchOutput);
      if (globalCtx) {
        globalCtx.fileOffset += batch.length;
        globalCtx.durationOffset += batchTotal;
        globalCtx.currentBatch++;
      }
      log(`  Batch ${b + 1} complete.`);
    }

    // Phase 1b: If audio failed, re-process all batches without audio
    if (audioFailed) {
      intermediates = [];
      log("");
      log("{yellow-fg}Retrying all batches without audio...{/yellow-fg}");

      if (globalCtx) {
        globalCtx.fileOffset = 0;
        globalCtx.durationOffset = 0;
        globalCtx.currentBatch = 0;
        globalCtx.startTime = Date.now();
      }

      for (let b = 0; b < batches.length; b++) {
        const batch = batches[b];
        const batchDurs = batchDurations[b];
        const batchTotal = batchDurs.reduce((a, c) => a + c, 0);
        const batchOutput = path.join(tmpDir, `batch_${b}_vo.mp4`);

        log(`{bold}Batch ${b + 1}/${batches.length}{/bold} (video only, ${batch.length} files)...`);

        const { videoOnlyArgs } = buildFFmpegArgs(batch, width, height, fps, null, batchOutput, glitchSet, preset);

        let code;
        if (useTui) {
          code = await runFFmpegTUI(screen, logBox, progressBox, videoOnlyArgs, batch, batchDurs, batchTotal, globalCtx);
        } else {
          code = await runFFmpegInherit(videoOnlyArgs);
        }

        if (code !== 0) {
          if (useTui) {
            progressBox.setContent(
              `\n  {red-fg}{bold}Error:{/bold} Batch ${b + 1} failed (exit code ${code}){/red-fg}\n\n  Press {bold}q{/bold} to exit.`
            );
            screen.render();
          } else {
            console.error(`Batch ${b + 1} failed (exit code ${code})`);
            process.exit(code);
          }
          return;
        }
        intermediates.push(batchOutput);
        if (globalCtx) {
          globalCtx.fileOffset += batch.length;
          globalCtx.durationOffset += batchTotal;
          globalCtx.currentBatch++;
        }
        log(`  Batch ${b + 1} complete.`);
      }
    }

    // Phase 2: Concat intermediates using concat demuxer (no re-encoding)
    log("");
    log("{bold}Concatenating batches...{/bold}");

    if (globalCtx) {
      globalCtx.phase = "Stitching";
    }

    const concatListPath = path.join(tmpDir, "concat_list.txt");
    writeConcatList(intermediates, concatListPath);
    const concatArgs = buildConcatArgs(concatListPath, audioFailed ? null : bgmPath, outputFile);

    let concatCode;
    if (useTui) {
      progressBox.setContent("  Concatenating batch outputs...");
      screen.render();
      const batchSumDurations = batches.map((_, b) =>
        batchDurations[b].reduce((a, c) => a + c, 0)
      );
      concatCode = await runFFmpegTUI(
        screen, logBox, progressBox, concatArgs,
        intermediates, batchSumDurations, totalDuration,
        globalCtx
      );
    } else {
      concatCode = await runFFmpegInherit(concatArgs);
    }

    const suffix = audioFailed ? " (video only)" : "";
    if (concatCode === 0) {
      if (useTui) {
        progressBox.setContent(
          `\n  {green-fg}{bold}Done!{/bold}{/green-fg} Output saved to ${outputFile}${suffix}\n\n  Press {bold}q{/bold} to exit.`
        );
        logBox.log("");
        logBox.log("Finished successfully.");
        screen.render();
      } else {
        console.log(`\nDone! Output saved to ${outputFile}${suffix}`);
      }
    } else {
      if (useTui) {
        progressBox.setContent(
          `\n  {red-fg}{bold}Error:{/bold} Concat failed (exit code ${concatCode}){/red-fg}\n\n  Press {bold}q{/bold} to exit.`
        );
        logBox.log(`Concat failed with code ${concatCode}`);
        screen.render();
      } else {
        console.error(`\nConcat failed (exit code ${concatCode})`);
        process.exit(concatCode);
      }
    }
  } finally {
    if (!noDeleteTemp) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
    }
  }
}

// ── Main ────────────────────────────────────────────────────────

async function run() {
  const { inputFolder, outputFile, bgmPath, noTui, glitch, tempDir, noDeleteTemp, fromIdx, toIdx, fatMode, recursive, fast } = parseArgs(
    process.argv.slice(2)
  );

  if (!fs.existsSync(inputFolder) || !fs.statSync(inputFolder).isDirectory()) {
    console.error(`Error: "${inputFolder}" is not a valid directory.`);
    process.exit(1);
  }

  console.error(`Input folder: ${inputFolder}`);
  if (bgmPath) console.error(`BGM path: ${bgmPath}`);

  if (bgmPath && !fs.existsSync(bgmPath)) {
    console.error(`Error: BGM file "${bgmPath}" not found.`);
    process.exit(1);
  }

  console.error(`Scanning for video files${recursive ? " (recursive)" : ""}...`);
  const files = collectVideoFiles(inputFolder, recursive).sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true })
  );

  if (files.length === 0) {
    console.error("No video files found in the input folder.");
    process.exit(1);
  }

  // Apply --from / --to range (1-based, inclusive)
  const rangeStart = fromIdx ? fromIdx - 1 : 0;
  const rangeEnd = toIdx ? toIdx : files.length;
  if (rangeStart >= files.length || rangeStart < 0 || rangeEnd < 1) {
    console.error(`Error: --from/--to range is out of bounds (${files.length} files found).`);
    process.exit(1);
  }
  const selectedFiles = files.slice(rangeStart, rangeEnd);

  if (selectedFiles.length === 0) {
    console.error("No video files in the specified range.");
    process.exit(1);
  }

  if (fromIdx || toIdx) {
    console.error(`Range: files ${rangeStart + 1}–${rangeStart + selectedFiles.length} of ${files.length}`);
  }

  console.error(`Found ${selectedFiles.length} video file(s). Probing files...`);

  // Probe all files (in parallel) and filter out corrupted ones
  const { validFiles, durations, infos, skipped } = await probeFiles(selectedFiles);

  if (skipped.length > 0) {
    console.error(`\nWarning: Skipped ${skipped.length} corrupted file(s):`);
    skipped.forEach((name) => console.error(`  - ${name}`));
  }

  if (validFiles.length === 0) {
    console.error("Error: No valid video files found after probing.");
    process.exit(1);
  }

  // Get target resolution from first valid file
  const { width, height, fps } = infos[0];
  console.error(`  Target: ${width}x${height} @ ${fps.toFixed(2)} fps`);

  const totalDuration = durations.reduce((a, b) => a + b, 0);
  console.error(`Total duration: ${formatTime(totalDuration)}`);

  // Detect files with corrupted frames (parallel decode check)
  let glitchSet = null;
  if (glitch) {
    console.error(`\nDetecting corrupted frames (${Math.min(os.cpus().length, 8)} threads)...`);
    glitchSet = await detectGlitchFiles(validFiles);
    if (glitchSet.size > 0) {
      console.error(`Found ${glitchSet.size} file(s) with corrupted frames (will overlay GLITCH).`);
    } else {
      console.error("No corrupted frames detected.");
    }
  }

  const useTui = blessed && !noTui && process.stderr.isTTY;
  const preset = fast ? "veryfast" : "medium";

  // ── Batched mode for large file counts ──
  // When there are many files, ffmpeg hits the OS file descriptor limit
  // (typically 256 on macOS). Process in batches and concat the results.
  if (validFiles.length > BATCH_SIZE) {
    await processBatched({
      validFiles, durations, width, height, fps, bgmPath,
      outputFile, totalDuration, skipped, useTui, glitchSet, tempDir, noDeleteTemp, fatMode, preset,
    });
    return;
  }

  // Build ffmpeg args
  const { withAudioArgs, videoOnlyArgs } = buildFFmpegArgs(
    validFiles,
    width,
    height,
    fps,
    bgmPath,
    outputFile,
    glitchSet,
    preset
  );

  // ── Legacy mode ──
  if (!useTui) {
    console.log(`Found ${validFiles.length} video file(s):`);
    validFiles.forEach((f) => console.log(`  ${path.basename(f)}`));
    if (bgmPath) console.log(`BGM: ${path.basename(bgmPath)}`);
    console.log(`\nTarget: ${width}x${height} @ ${fps.toFixed(2)} fps`);
    console.log(`Total duration: ${formatTime(totalDuration)}`);
    console.log("\nStitching videos...");
    runLegacy(withAudioArgs, outputFile, videoOnlyArgs);
    return;
  }

  // ── TUI mode ──
  const { screen, logBox, progressBox } = createUI();

  // Print header info into the log
  logBox.log(`Found ${validFiles.length} video file(s):`);
  validFiles.forEach((f, i) => {
    logBox.log(`  ${path.basename(f)}  (${formatTime(durations[i])})`);
  });
  if (bgmPath) logBox.log(`BGM: ${path.basename(bgmPath)}`);
  logBox.log(`Target: ${width}x${height} @ ${fps.toFixed(2)} fps`);
  logBox.log(`Total duration: ${formatTime(totalDuration)}`);
  logBox.log("");
  logBox.log("Starting ffmpeg (with audio)...");
  screen.render();

  if (skipped.length > 0) {
    logBox.log(`{yellow-fg}Skipped ${skipped.length} corrupted file(s):{/yellow-fg}`);
    skipped.forEach((name) => logBox.log(`  {yellow-fg}- ${name}{/yellow-fg}`));
    logBox.log("");
  }

  const code = await runFFmpegTUI(
    screen,
    logBox,
    progressBox,
    withAudioArgs,
    validFiles,
    durations,
    totalDuration
  );

  if (code === 0) {
    // Show completion in the UI
    progressBox.setContent(
      `\n  {green-fg}{bold}Done!{/bold}{/green-fg} Output saved to ${outputFile}\n\n  Press {bold}q{/bold} to exit.`
    );
    logBox.log("");
    logBox.log("Finished successfully.");
    screen.render();
    // Wait for user to dismiss
    return;
  }

  // ── Retry without audio ──
  logBox.log("");
  logBox.log("{yellow-fg}Audio encoding failed. Retrying without audio...{/yellow-fg}");
  screen.render();

  const code2 = await runFFmpegTUI(
    screen,
    logBox,
    progressBox,
    videoOnlyArgs,
    validFiles,
    durations,
    totalDuration
  );

  if (code2 === 0) {
    progressBox.setContent(
      `\n  {green-fg}{bold}Done!{/bold}{/green-fg} Output saved to ${outputFile} (video only)\n\n  Press {bold}q{/bold} to exit.`
    );
    logBox.log("");
    logBox.log("Finished successfully (video only).");
  } else {
    progressBox.setContent(
      `\n  {red-fg}{bold}Error:{/bold} ffmpeg exited with code ${code2}{/red-fg}\n\n  Press {bold}q{/bold} to exit.`
    );
    logBox.log("");
    logBox.log(`ffmpeg exited with code ${code2}`);
  }
  screen.render();
}

run();
