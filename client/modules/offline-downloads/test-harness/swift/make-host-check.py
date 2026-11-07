#!/usr/bin/env python3
"""Compile the unchanged engine for macOS: only the OS guard and the Application Support root change.
No activate(), background session, device or app is started; the same-file extension replays delegate callbacks.
"""
from pathlib import Path

module = Path(__file__).resolve().parents[2]
work = module / 'test-harness/.work'
work.mkdir(parents=True, exist_ok=True)
source = (module / 'ios/OfflineDownloadEngine.swift').read_text()
assert source.count('#if os(iOS)') == 1
source = source.replace('#if os(iOS)', '#if os(macOS)', 1)
old = 'let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]'
assert source.count(old) == 1
source = source.replace(old, 'let support = URL(fileURLWithPath: ProcessInfo.processInfo.environment["DL_HARNESS_SWIFT_ROOT"]!)')
checks = (Path(__file__).parent / 'EngineHostCheck.swift').read_text()
(work / 'EngineHostCheck.generated.swift').write_text(source + '\n' + checks)
print(work / 'EngineHostCheck.generated.swift')
