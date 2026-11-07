#!/usr/bin/env python3
"""Compile the unchanged engine for macOS: only the OS guard and the Application Support root change.
No activate(), background session, device or app is started; the same-file extension replays delegate callbacks.
"""
from pathlib import Path

module = Path(__file__).resolve().parents[2]
work = module / 'test-harness/.work'
work.mkdir(parents=True, exist_ok=True)
source = (module / 'ios/OfflineDownloadEngine.swift').read_text()
# N2-04: waits and budgets need a sleep-inclusive clock; these stop while the device sleeps (comments are not scanned).
code = '\n'.join(line.split('//')[0] for line in source.splitlines())
for banned in ('mach_absolute_time', 'CLOCK_UPTIME_RAW', 'systemUptime', 'SuspendingClock', 'CACurrentMediaTime'):
    assert banned not in code, f'OfflineDownloadEngine.swift uses {banned}, which stops in sleep (N2-04)'
assert source.count('#if os(iOS)') == 1
source = source.replace('#if os(iOS)', '#if os(macOS)', 1)
old = 'let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]'
assert source.count(old) == 1
source = source.replace(old, 'let support = URL(fileURLWithPath: ProcessInfo.processInfo.environment["DL_HARNESS_SWIFT_ROOT"]!)')
old = 'let osRoot = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]'
assert source.count(old) == 1
source = source.replace(old, 'let osRoot = URL(fileURLWithPath: ProcessInfo.processInfo.environment["DL_HARNESS_SWIFT_ROOT"]!).appendingPathComponent("os-caches")')
old = 'osTempURL = FileManager.default.temporaryDirectory'
assert source.count(old) == 1
source = source.replace(old, 'osTempURL = URL(fileURLWithPath: ProcessInfo.processInfo.environment["DL_HARNESS_SWIFT_ROOT"]!).appendingPathComponent("os-tmp")')
checks = (Path(__file__).parent / 'EngineHostCheck.swift').read_text()
(work / 'EngineHostCheck.generated.swift').write_text(source + '\n' + checks)
print(work / 'EngineHostCheck.generated.swift')
