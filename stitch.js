#!/usr/bin/env node

const { execSync, spawn } = require("child_process");
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

// ── Argument parsing ────────────────────────────────────────────

function usage() {
  console.error(
    "Usage: node stitch.js <input-folder> [output-file] [--bgm <audio-file>] [--no-tui]\n" +
      "  input-folder  Directory containing video files\n" +
      "  output-file   Output filename (default: output.mp4)\n" +
      "  --bgm         Path to background music file (lowers gameplay audio to 75%)\n" +
      "  --no-tui      Disable the progress UI (plain ffmpeg output)"
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
  };
}

// ── ffprobe helpers ─────────────────────────────────────────────

function probe(filePath, showFlags) {
  const cmd = [
    "ffprobe",
    "-v",
    "quiet",
    "-print_format",
    "json",
    ...showFlags,
    filePath,
  ];
  const result = execSync(cmd.map((c) => `"${c}"`).join(" "), {
    encoding: "utf-8",
  });
  return JSON.parse(result);
}

function getVideoInfo(filePath) {
  const data = probe(filePath, ["-show_streams", "-select_streams", "v:0"]);
  const stream = data.streams && data.streams[0];
  if (!stream) throw new Error(`No video stream found in ${filePath}`);

  let fps = 30;
  if (stream.r_frame_rate) {
    const [num, den] = stream.r_frame_rate.split("/").map(Number);
    if (den > 0) fps = num / den;
  }
  return { width: stream.width, height: stream.height, fps };
}

function getDuration(filePath) {
  try {
    const data = probe(filePath, ["-show_format"]);
    return parseFloat(data.format?.duration) || 0;
  } catch {
    return 0;
  }
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

function buildFFmpegArgs(files, width, height, fps, bgmPath, outputFile) {
  const inputArgs = [];
  const filterParts = [];
  const bgmIndex = bgmPath ? files.length : null;

  files.forEach((file, i) => {
    inputArgs.push("-i", file);
    const filename = path.basename(file).replace(/'/g, "'\\''");
    const fontSize = Math.max(16, Math.round(height / 25));
    filterParts.push(
      `[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
        `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,` +
        `setsar=1,fps=${fps},` +
        `drawtext=text='${filename}':fontsize=${fontSize}:` +
        `fontcolor=white@0.3:x=(w-tw)/2:y=h-th-20` +
        `[v${i}]`
    );
  });

  if (bgmPath) inputArgs.push("-i", bgmPath);

  const concatInputs = files.map((_, i) => `[v${i}]`).join("");
  const videoConcat =
    filterParts.join("; ") +
    `; ${concatInputs}concat=n=${files.length}:v=1:a=0[outv]`;

  const audioConcat = files.map((_, i) => `[${i}:a]`).join("");

  let filterWithAudio;
  if (bgmPath) {
    filterWithAudio =
      videoConcat +
      `; ${audioConcat}concat=n=${files.length}:v=0:a=1[gamea]` +
      `; [gamea]volume=0.75[gamevol]` +
      `; [${bgmIndex}:a]aloop=loop=-1:size=2147483647[bgmloop]` +
      `; [gamevol][bgmloop]amix=inputs=2:duration=first:dropout_transition=0[outa]`;
  } else {
    filterWithAudio =
      videoConcat +
      `; ${audioConcat}concat=n=${files.length}:v=0:a=1[outa]`;
  }

  const filterVideoOnly = videoConcat;

  const commonTail = [
    "-c:v",
    "libx264",
    "-preset",
    "medium",
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

// ── TUI ─────────────────────────────────────────────────────────

function createUI() {
  const screen = blessed.screen({
    smartCSR: true,
    title: "vidstitch",
    fullUnicode: true,
  });

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

function runFFmpegTUI(screen, logBox, progressBox, ffmpegArgs, files, durations, totalDuration) {
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
    const args = ["-nostdin", ...ffmpegArgs, "-nostats", "-progress", "pipe:1"];
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

      const totalFraction = totalDuration > 0 ? currentTime / totalDuration : 0;

      // Find current file
      let fileIdx = 0;
      for (let i = 0; i < cumDurations.length; i++) {
        if (currentTime >= cumDurations[i]) fileIdx = i;
      }
      const fileStart = cumDurations[fileIdx];
      const fileDur = durations[fileIdx] || 1;
      const fileFraction = (currentTime - fileStart) / fileDur;

      const elapsed = (Date.now() - startTime) / 1000;
      const eta = totalFraction > 0.001 ? elapsed / totalFraction - elapsed : 0;

      const barWidth = Math.max(10, (screen.width || 80) - 26);

      const fileBar = makeBarColored(fileFraction, barWidth, "yellow");
      const totalBar = makeBarColored(totalFraction, barWidth, "green");

      const filePct = (Math.min(1, fileFraction) * 100).toFixed(1);
      const totalPct = (Math.min(1, totalFraction) * 100).toFixed(1);
      const fileName = path.basename(files[fileIdx]);
      const speedStr = speed > 0 ? speed.toFixed(2) + "x" : "...";

      progressBox.setContent(
        `  {bold}File ${fileIdx + 1}/${files.length}{/bold}: ${fileName}\n` +
          `  File   ${fileBar}  ${filePct.padStart(5)}%\n` +
          `  Total  ${totalBar}  ${totalPct.padStart(5)}%\n` +
          `\n` +
          `  Elapsed: {cyan-fg}${formatTime(elapsed)}{/cyan-fg}` +
          `   Speed: {cyan-fg}${speedStr}{/cyan-fg}` +
          `   ETA: {cyan-fg}${formatTime(eta)}{/cyan-fg}`
      );
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

// ── Main ────────────────────────────────────────────────────────

async function run() {
  const { inputFolder, outputFile, bgmPath, noTui } = parseArgs(
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

  console.error("Scanning for video files...");
  const files = fs
    .readdirSync(inputFolder)
    .filter((f) => VIDEO_EXTENSIONS.has(path.extname(f).toLowerCase()))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((f) => path.join(inputFolder, f));

  if (files.length === 0) {
    console.error("No video files found in the input folder.");
    process.exit(1);
  }

  console.error(`Found ${files.length} video file(s). Probing files...`);

  // Probe all files and filter out corrupted ones
  const validFiles = [];
  const durations = [];
  const skipped = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const name = path.basename(f);
    const pct = Math.round((i / files.length) * 100);
    if (process.stderr.isTTY) {
      process.stderr.write(`  ${String(pct).padStart(3)}% [${i + 1}/${files.length}] ${name}...`);
    }
    let dur = 0;
    let info = null;
    try {
      dur = getDuration(f);
      info = getVideoInfo(f);
    } catch {
      // probe failed — file is unreadable
    }
    if (process.stderr.isTTY) {
      process.stderr.clearLine(0);
      process.stderr.cursorTo(0);
    }
    const donePct = Math.round(((i + 1) / files.length) * 100);
    if (!info || dur <= 0) {
      console.error(`  ${String(donePct).padStart(3)}% [${i + 1}/${files.length}] ${name} → SKIPPED (corrupted or unreadable)`);
      skipped.push(name);
    } else {
      console.error(`  ${String(donePct).padStart(3)}% [${i + 1}/${files.length}] ${name} → ${formatTime(dur)} (${dur.toFixed(2)}s)`);
      validFiles.push(f);
      durations.push(dur);
    }
  }

  if (skipped.length > 0) {
    console.error(`\nWarning: Skipped ${skipped.length} corrupted file(s):`);
    skipped.forEach((name) => console.error(`  - ${name}`));
  }

  if (validFiles.length === 0) {
    console.error("Error: No valid video files found after probing.");
    process.exit(1);
  }

  // Get target resolution from first valid file
  const { width, height, fps } = getVideoInfo(validFiles[0]);
  console.error(`  Target: ${width}x${height} @ ${fps.toFixed(2)} fps`);

  const totalDuration = durations.reduce((a, b) => a + b, 0);
  console.error(`Total duration: ${formatTime(totalDuration)}`);

  // Build ffmpeg args
  const { withAudioArgs, videoOnlyArgs } = buildFFmpegArgs(
    validFiles,
    width,
    height,
    fps,
    bgmPath,
    outputFile
  );

  // ── Legacy mode ──
  const useTui = blessed && !noTui && process.stderr.isTTY;
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
    files,
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
