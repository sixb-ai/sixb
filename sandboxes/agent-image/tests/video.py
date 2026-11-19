"""Render a video offline, the way a video artifact's scenes are rendered, and check it frame by frame."""

# Regression check: delete the HYPERFRAMES_BROWSER_PATH line from profile.sh; HyperFrames then looks
# for a browser of its own, offline, and the first render fails.

import subprocess
from pathlib import Path

from PIL import Image

# One second at 30 fps: a title slides 160 px with a CSS animation, no script and no network.
COMPOSITION = """<!doctype html>
<html>
  <head>
    <style>
      html, body { margin: 0; width: 320px; height: 180px; background: #0b1020; }
      #title {
        position: absolute; left: 20px; top: 70px;
        color: #fff; font: 28px "DejaVu Sans", sans-serif;
        animation: slide 1s linear both;
      }
      @keyframes slide { from { transform: translateX(0); } to { transform: translateX(160px); } }
    </style>
  </head>
  <body>
    <div data-composition-id="main" data-width="320" data-height="180" data-start="0" data-duration="1">
      <div id="title" data-start="0" data-duration="1">Sixb</div>
    </div>
  </body>
</html>
"""


def login_shell(command, cwd):
    # The image ENV cleared, as on a provider that drops it: profile.sh must restore it.
    result = subprocess.run(
        ["env", "-i", f"HOME={Path.home()}", "bash", "-lc", command],
        cwd=cwd, capture_output=True, text=True, timeout=180,
    )
    if result.returncode:
        raise AssertionError(f"{command}: {result.stderr or result.stdout}")
    return result.stdout


def frame_hashes(video):
    output = login_shell(f"ffmpeg -v error -i {video} -f framemd5 -", video.parent)
    return [line.split(",")[-1].strip() for line in output.splitlines() if not line.startswith("#")]


def title_left(frame):
    with Image.open(frame) as image:
        box = image.convert("L").point(lambda value: 255 if value > 200 else 0).getbbox()
    assert box, f"{frame.name}: the title is missing"
    return box[0]


def check_video(root):
    project = root / "video"
    project.mkdir()
    (project / "index.html").write_text(COMPOSITION)

    login_shell("hyperframes render --quiet -o first.mp4", project)
    login_shell("hyperframes render --quiet -o second.mp4", project)

    probe = login_shell(
        "ffprobe -v error -count_frames -select_streams v "
        "-show_entries stream=codec_name,width,height,nb_read_frames -of csv=p=0 first.mp4",
        project,
    )
    assert probe.strip() == "h264,320,180,30", probe

    first, second = frame_hashes(project / "first.mp4"), frame_hashes(project / "second.mp4")
    assert len(first) == 30 and first == second, "two renders of the same composition differ"

    # Frame 0 and frame 29 of 30: the title must have moved 29/30 of 160 px, give or take a pixel.
    login_shell("ffmpeg -v error -i first.mp4 -vf 'select=eq(n\\,0)+eq(n\\,29)' -vsync 0 frame%d.png", project)
    moved = title_left(project / "frame2.png") - title_left(project / "frame1.png")
    assert abs(moved - 160 * 29 / 30) <= 1.5, f"the title moved {moved} px"

    return ["video-render-offline", "video-render-deterministic"]
