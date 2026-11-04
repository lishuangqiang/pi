# MCP stdio fragmented-message buffering (#11761)

This branch fixes [#11761](https://github.com/earendil-works/pi/issues/11761) on fork baseline `a57438e91`. The buffering code was moved from `StdioTransport` into the shared `JsonRpcLineReader` before this baseline, so the change applies to both `StdioTransport` and `PipeTransport`.

## Implementation

Previously, every stdout chunk concatenated and rescanned the entire pending prefix. A line of length L delivered in fixed-size chunks therefore incurred quadratic cumulative copying and scanning before decoding.

The reader now retains incomplete fragments and their total byte count, searches only the new chunk, and concatenates a completed fragmented line once. A complete line within a single chunk is decoded directly from its slice. Message-size checks, error text, UTF-8 decoding, CRLF/blank-line behavior, invalid-line recovery, and incomplete-message reporting on close remain unchanged. Stderr buffering and process shutdown were not changed.

The pending byte limit still applies; queue metadata also depends on the number of fragments. This is not a new claim of a hard process-memory cap.

## Regression tests

Run from the repository root after `npm ci --ignore-scripts`:

```sh
cd packages/mcp
node ../../node_modules/vitest/dist/cli.js --run test/lines.test.ts
```

The 17 new tests cover split UTF-8, byte-at-a-time delivery, CRLF splits, multiple/blank/invalid lines, Uint8Array view offsets, exact byte limits, oversized-line recovery, incomplete final messages, empty chunks, unchanged stderr behavior, and buffering work counts.

The performance assertions count `Buffer.concat` output bytes and newline-search windows rather than timing thresholds. They require one complete-line copy for fragmented 4 MiB and 12 MiB results, at most one scan of the new bytes, and no concatenation for complete lines already in a chunk. They also verify the entire decoded large result.

The same tests run against the unmodified baseline produced 14 passes and 3 expected failures: 65 and 193 concatenations for the large cases, and one avoidable concatenation for already-complete messages.

On the fixed branch, all 14 MCP test files passed: **139 tests**. The root **`npm run check` passed** after hydrating the gitignored model data with `npm run hydrate:model-data`. No dependency or lockfile changes are included. No full-monorepo test suite or actual provider API was run.

An additional temporary differential check compared messages and errors, in order, against the original reader for 1,000 deterministic random chunk sequences (seed 11761), mixing UTF-8, CRLF, blank/invalid/oversized lines, empty chunks, and incomplete final data. All 1,000 matched.

## Reproducible benchmark

```sh
node packages/mcp/test/bench/stdio-buffer.ts fixed
```

For an original-reader comparison, run the same benchmark file in a separate checkout of `a57438e91` at the same relative path. The script imports that checkout's actual `JsonRpcLineReader`; it does not maintain a second parser implementation. Each run creates only finite local subprocesses and uses no external service or model API.

Measurements below used Node.js 24.20.0 on macOS. Parser medians use seven timed samples after two warm-ups, with copying instrumentation in a separate untimed run. Subprocess medians use five runs and include Node startup, JSON serialization, pipe transfer, and decoding. These are one-machine transport-level measurements, not whole-Pi latency guarantees or peak memory figures.

| Scenario | Baseline | Fixed |
| --- | ---: | ---: |
| 4 MiB payload, 64 KiB chunks: concatenations | 65 | 1 |
| 4 MiB payload: cumulative concat bytes | 140,509,230 | 4,194,349 |
| 4 MiB payload: parser median | 6.55 ms | 1.69 ms |
| 4 MiB payload: subprocess median | 55.12 ms | 50.21 ms |
| 12 MiB payload, 64 KiB chunks: concatenations | 193 | 1 |
| 12 MiB payload: cumulative concat bytes | 1,226,833,966 | 12,582,957 |
| 12 MiB payload: parser median | 53.36 ms | 5.65 ms |
| 12 MiB payload: subprocess median | 120.07 ms | 59.33 ms |
| 20,000 small complete messages: concat bytes | 740,000 | 0 |
| 20,000 small complete messages: parser median | 6.91 ms | 6.36 ms |

Wire length includes JSON framing in addition to the repeated-text payload. The fixed reader excludes the newline from its single copy, so its copied byte count is one below wire length. Cumulative copy volume is not peak RSS or evidence of a memory leak.

AI assistance was used for implementation, regression tests, and validation. This fork change does not create an upstream PR or assert maintainer approval.
