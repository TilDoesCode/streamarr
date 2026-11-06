#!/usr/bin/env python3
"""Compare the unchanged versions-latency test, alone and with two CPU workers."""
import hashlib
import json
import multiprocessing as mp
from pathlib import Path
import re
import subprocess
import time
import xml.etree.ElementTree as E

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'tools/dl-verify'
NS = {'t': 'http://microsoft.com/schemas/VisualStudio/TeamTest/2010'}


def load(stop):
    while not stop.is_set():
        hashlib.pbkdf2_hmac('sha256', b'verifier', b'controlled-load', 20000)


if __name__ == '__main__':
    rows = []
    for mode in ['alone', 'two_cpu_workers']:
        stop = mp.Event()
        workers = [mp.Process(target=load, args=(stop,)) for _ in range(2 if mode != 'alone' else 0)]
        for p in workers:
            p.start()
        try:
            for trial in range(3):
                for label, path in [('current', ROOT / 'server'), ('before', OUT / 'pre-round2/server')]:
                    prefix = f'latency-{mode}-{trial}-{label}'
                    command = ['dotnet', 'test', 'tests/Streamarr.Server.Tests/Streamarr.Server.Tests.csproj', '--no-build', '--filter', 'FullyQualifiedName~ViewerVersionsLatencyTests', '--logger', 'trx;LogFileName=' + prefix + '.trx', '--results-directory', str(OUT / 'round3-test-results')]
                    with (OUT / (prefix + '.log')).open('w') as log:
                        r = subprocess.run(command, cwd=path, stdout=log, stderr=subprocess.STDOUT, timeout=120)
                    root = E.parse(OUT / 'round3-test-results' / (prefix + '.trx')).getroot()
                    for test in root.findall('t:Results/t:UnitTestResult', NS):
                        output = test.find('t:Output/t:StdOut', NS)
                        text = output.text if output is not None else ''
                        match = re.search(r'warm median=([\d.,]+)ms max=([\d.,]+)ms', text)
                        row = dict(mode=mode, tree=label, trial=trial, outcome=test.get('outcome'), exit=r.returncode, hostLoad=subprocess.check_output(['uptime'], text=True).strip())
                        if match:
                            row.update(medianMs=float(match[1].replace(',', '.')), maxMs=float(match[2].replace(',', '.')))
                        rows.append(row)
                        print(json.dumps(row), flush=True)
                    (OUT / 'round3-latency-results.json').write_text(json.dumps(rows, indent=2))
        finally:
            stop.set()
            for p in workers:
                p.join(3)
                if p.is_alive():
                    p.terminate()
