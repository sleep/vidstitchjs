#!/usr/bin/env node

const { execSync, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

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

function usage() {
  console.error(
    "Usage: node stitch.js <input-folder> [output-file]\n" +
      "  input-folder  Directory containing video files\n" +
      "  output-file   Output filename (default: output.mp4)"
  );
  process.exit(1);
}

function getVideoInfo(filePath) {
  const cmd = [
    "ffprobe",
    "-v",
    "quiet",
    "-print_format",
    "json",
    "-show_streams",
    "-select_streams",
    "v:0",
    filePath,
  ];
  const result = execSync(cmd.map((c) => `"${c}"`).join(" "), {
    encoding: "utf-8",
  });
  const data = JSON.parse(result);
  const stream = data.streams && data.streams[0];
  if (!stream) {
    throw new Error(`No video stream found in ${filePath}`);
  }
  const width = stream.width;
  const height = stream.height;
  let fps = 30;
  if (stream.r_frame_rate) {
    const [num, den] = stream.r_frame_rate.split("/").map(Number);
    if (den > 0) fps = num / den;
  }
  return { width, height, fps };
}

function run() {
  const args = process.argv.slice(2);
  if (args.length < 1) usage();

  const inputFolder = path.resolve(args[0]);
  const outputFile = path.resolve(args[1] || "output.mp4");

  if (!fs.existsSync(inputFolder) || !fs.statSync(inputFolder).isDirectory()) {
    console.error(`Error: "${inputFolder}" is not a valid directory.`);
    process.exit(1);
  }

  // Find and sort video files
  const files = fs
    .readdirSync(inputFolder)
    .filter((f) => VIDEO_EXTENSIONS.has(path.extname(f).toLowerCase()))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((f) => path.join(inputFolder, f));

  if (files.length === 0) {
    console.error("No video files found in the input folder.");
    process.exit(1);
  }

  console.log(`Found ${files.length} video file(s):`);
  files.forEach((f) => console.log(`  ${path.basename(f)}`));

  // Get resolution and framerate from the first video
  const { width, height, fps } = getVideoInfo(files[0]);
  console.log(`\nTarget: ${width}x${height} @ ${fps.toFixed(2)} fps`);

  // Build the ffmpeg command
  // Each input gets scaled to target resolution and has its filename overlaid
  const inputArgs = [];
  const filterParts = [];

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

  // Concatenate all processed streams
  const concatInputs = files.map((_, i) => `[v${i}]`).join("");
  const filterComplex =
    filterParts.join("; ") +
    `; ${concatInputs}concat=n=${files.length}:v=1:a=0[outv]`;

  // Build audio concatenation if available
  const audioConcat = files.map((_, i) => `[${i}:a]`).join("");
  const filterWithAudio =
    filterComplex +
    `; ${audioConcat}concat=n=${files.length}:v=0:a=1[outa]`;

  // Try with audio first, fall back to video-only
  const ffmpegArgs = [
    ...inputArgs,
    "-filter_complex",
    filterWithAudio,
    "-map",
    "[outv]",
    "-map",
    "[outa]",
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "18",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-movflags",
    "+faststart",
    "-y",
    outputFile,
  ];

  console.log("\nStitching videos...");

  const proc = spawn("ffmpeg", ffmpegArgs, { stdio: "inherit" });
  proc.on("close", (code) => {
    if (code === 0) {
      console.log(`\nDone! Output saved to ${outputFile}`);
      return;
    }

    // Retry without audio
    console.log("\nRetrying without audio...");
    const videoOnlyArgs = [
      ...inputArgs,
      "-filter_complex",
      filterComplex,
      "-map",
      "[outv]",
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      "18",
      "-an",
      "-movflags",
      "+faststart",
      "-y",
      outputFile,
    ];

    const proc2 = spawn("ffmpeg", videoOnlyArgs, { stdio: "inherit" });
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

run();
