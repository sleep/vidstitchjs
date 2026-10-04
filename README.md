# vidstitch

Point it at a folder of video clips, get one video back. It's a wrapper around ffmpeg with a progress UI so you can see how far along a long encode is.

Clips are joined in natural filename order (`clip2` before `clip10`). The first clip sets the resolution and framerate, and everything else is scaled and padded to match.

## Setup

You need Node.js, plus `ffmpeg` and `ffprobe` on your PATH.

```
git clone git@github.com:sleep/vidstitchjs.git
cd vidstitchjs
npm install
```

## Usage

```
node stitch.js <input-folder> [output-file] [options]
```

The output defaults to `output.mp4` in the current directory.

```
node stitch.js ~/clips
node stitch.js ~/clips montage.mp4 --bgm ~/music/song.mp3 --fast
node stitch.js ~/clips out.mp4 -r --from 20 --to 50
```

## Options

| Flag | What it does |
|------|--------------|
| `--bgm <file>` | Mix in background music, looped to fit. Clip audio drops to 75%. |
| `--fast` | Use x264's `veryfast` preset. About 3x quicker, near-identical quality. |
| `-r`, `--recursive` | Include clips in subdirectories. |
| `--from <n>`, `--to <n>` | Only stitch files n through m (1-based, inclusive). |
| `--glitch` | Scan for corrupted frames and stamp a "GLITCH" label on affected clips. |
| `--fat-mode` | Keep temp files under 4GB for FAT32 drives. |
| `--temp-dir <path>` | Where to put intermediate files (default: OS temp). |
| `--no-delete-temp` | Keep intermediate files when done. |
| `--no-tui` | Plain ffmpeg output instead of the progress UI. |

Press `q` or Ctrl-C to quit mid-run. Unreadable files are skipped with a warning.

More detail in [rtfm.md](rtfm.md).
