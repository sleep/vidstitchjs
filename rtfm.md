# vidstitch

Concatenates a folder of video clips into a single file. Uses ffmpeg under the hood.

## Requirements

- Node.js
- ffmpeg and ffprobe on your PATH

## Install

```
npm install
```

## Usage

```
node stitch.js <input-folder> [output-file] [options]
```

Point it at a folder full of video files. They get sorted alphabetically (with natural number ordering) and stitched together. The first video's resolution and framerate are used as the target — everything else gets scaled/padded to match.

Output defaults to `output.mp4` in the current directory if you don't specify one.

### Supported formats

mp4, mkv, avi, mov, wmv, flv, webm, m4v, mpg, mpeg, ts, mts

### Options

`--bgm <file>` — mix in a background music track. It loops automatically if it's shorter than the video. Gameplay audio gets dropped to 75% so the music doesn't get buried.

`--glitch` — scans every file for corrupted frames before stitching. Files with errors get a purple "GLITCH" label in the top-right corner of the output.

`--no-tui` — disables the progress UI and just dumps raw ffmpeg output. Useful if you're piping output or running in a non-interactive shell.

`--temp-dir <path>` — use a specific directory for intermediate batch files instead of the OS temp folder.

`--no-delete-temp` — keep the intermediate files around after it finishes. Handy for debugging.

`--from <n>` — start from the nth file (1-based). So `--from 5` skips the first four.

`--to <n>` — stop at the nth file (inclusive). `--from 5 --to 10` processes files 5 through 10.

`--fat-mode` — limits batch temp files to under 4GB each, for FAT32 filesystems. Batches are split by duration (~15 min per batch) instead of file count.

### Examples

Basic:
```
node stitch.js ~/clips
```

Custom output with background music:
```
node stitch.js ~/clips montage.mp4 --bgm ~/music/song.mp3
```

Process only files 20-50, no progress UI:
```
node stitch.js ~/clips out.mp4 --from 20 --to 50 --no-tui
```

## Notes

- Files that ffprobe can't read get skipped automatically with a warning.
- If audio encoding fails on any batch, it retries the whole thing without audio rather than dying.
- Large jobs (50+ files) are processed in batches to avoid hitting OS file descriptor limits, then concatenated at the end.
- Press `q` or Ctrl-C in the TUI to bail out.
