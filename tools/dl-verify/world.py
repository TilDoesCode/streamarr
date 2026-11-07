#!/usr/bin/env python3
"""Own-PID-only control of verifier Dev World (39311), with all state in this tree."""
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT/'tools/dl-verify'
DLL = ROOT/'server/tests/Streamarr.DevWorld/bin/Debug/net8.0/Streamarr.DevWorld.dll'
PID = OUT/'devworld.pid'


def ready():
    try:
        with urllib.request.urlopen('http://127.0.0.1:39311/devworld/ready',timeout=1) as r:
            return r.status == 200
    except Exception:
        return False


def stop():
    if not PID.exists():
        return
    pid = int(PID.read_text())
    process = subprocess.run(['ps','-p',str(pid),'-o','command='],capture_output=True,text=True).stdout
    if not process.strip():
        PID.unlink(missing_ok=True)
        return
    assert str(DLL) in process, f'Refusing to stop unrelated PID {pid}'
    os.kill(pid,signal.SIGTERM)
    for _ in range(100):
        try:
            os.kill(pid,0)
        except ProcessLookupError:
            break
        time.sleep(.1)
    PID.unlink(missing_ok=True)
    print('Stopped owned verifier PID',pid,flush=True)


def start(keep=False):
    assert not ready(), '39311 is already in use; stop only the recorded owned process first'
    env = os.environ.copy()
    env.update(DEVWORLD_PORT='39311',DEVWORLD_HOST='127.0.0.1',DEVWORLD_PRIMARY='0',DEVWORLD_CACHE_DIR=str(ROOT/'server/tests/Streamarr.DevWorld/cache'),DEVWORLD_STATE_DIR=str(OUT/'state'),DEVWORLD_KEEP_DATA='1' if keep else '0')
    with open(OUT/'devworld.log','a' if keep else 'w') as log:
        p = subprocess.Popen(['dotnet',str(DLL)],env=env,stdin=subprocess.DEVNULL,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
    PID.write_text(str(p.pid))
    print('Started owned verifier PID',p.pid,flush=True)
    for _ in range(120):
        if ready():
            print('Ready on 39311',flush=True)
            return
        time.sleep(.5)
    raise TimeoutError('See tools/dl-verify/devworld.log')


if __name__ == '__main__':
    if sys.argv[1] in ('stop','restart'):
        stop()
    if sys.argv[1] in ('start','restart'):
        start('--keep-data' in sys.argv)
