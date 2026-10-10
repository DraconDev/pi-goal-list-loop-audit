#!/usr/bin/env python3
"""Capture real xterm rasterization on a private, bounded Xvfb display.
Requires Xvfb, xterm, xdotool and Pillow; never touches the user's display.
First run: timeout 30 bun scripts/ui-status-capture.ts
Then: timeout 60 python3 scripts/capture-ui-status.py
"""
import json
import os
from pathlib import Path
import select
import subprocess
import sys
import tempfile
import time
from PIL import ImageGrab

if len(sys.argv) > 1 and sys.argv[1] == '--paint':
    sys.stdout.buffer.write(b'\x1b[?25l\x1b[2J\x1b[H' + Path(sys.argv[2]).read_bytes())
    sys.stdout.buffer.flush()
    Path(sys.argv[3]).touch()
    time.sleep(45)  # parent captures, then terminates this private terminal
    raise SystemExit(0)

def stop(process):
    if process is not None and process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=3)

root = Path(__file__).resolve().parents[1]
out = root / 'audit' / 'ui-captures'
xvfb = terminal = None
read_fd, write_fd = os.pipe()
try:
    xvfb = subprocess.Popen(['Xvfb', '-displayfd', str(write_fd), '-screen', '0', '1600x2600x24', '-nolisten', 'tcp'],
                            pass_fds=(write_fd,), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    os.close(write_fd)
    if not select.select([read_fd], [], [], 5)[0]:
        raise RuntimeError('Private Xvfb did not start within 5s')
    display = ':' + os.read(read_fd, 32).decode().strip()
    env = {**os.environ, 'DISPLAY': display}
    with tempfile.TemporaryDirectory(prefix='glla-capture-') as temporary:
        for width in [40, 120]:
            metadata = json.loads((out / f'{width}.json').read_text())
            marker = Path(temporary) / f'ready-{width}'
            terminal = subprocess.Popen(['xterm', '-geometry', f'{width}x{metadata["rows"] + 2}+0+0',
                                         '-fa', 'Hack', '-fs', '11', '-fg', '#ddd9ea', '-bg', '#181622',
                                         '-b', '10', '-title', f'GLLA capture {width}', '-e', sys.executable,
                                         str(Path(__file__).resolve()), '--paint', str(out / f'{width}.ansi'), str(marker)],
                                        env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            deadline = time.monotonic() + 10
            while not marker.exists():
                if terminal.poll() is not None or time.monotonic() > deadline:
                    raise RuntimeError('Private terminal renderer did not become ready')
                time.sleep(0.05)
            window = subprocess.check_output(['xdotool', 'search', '--name', f'GLLA capture {width}'], env=env, timeout=5).decode().splitlines()[-1]
            geometry = subprocess.check_output(['xdotool', 'getwindowgeometry', '--shell', window], env=env, timeout=5).decode()
            values = dict(line.split('=', 1) for line in geometry.splitlines() if '=' in line)
            x, y, w, h = [int(values[key]) for key in ['X', 'Y', 'WIDTH', 'HEIGHT']]
            if w > 1600 or h > 2600:
                raise RuntimeError('Terminal exceeds private framebuffer; refusing a clipped capture')
            # Brief raster flush after the output-ready IPC marker.
            time.sleep(0.2)
            image = ImageGrab.grab(xdisplay=display).crop((x, y, x + w, y + h))
            image.convert('P', palette=1, colors=128).save(out / f'{width}.png', optimize=True)
            metadata.update({'capture': 'real xterm on private Xvfb', 'pixels': [w, h]})
            (out / f'{width}.json').write_text(json.dumps(metadata, indent=2) + '\n')
            stop(terminal)
            terminal = None
finally:
    os.close(read_fd)
    stop(terminal)
    stop(xvfb)
