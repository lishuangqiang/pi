// Reproduce #11761 without model APIs: node packages/mcp/test/bench/stdio-buffer.ts [label]
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import type { JsonRpcMessage } from "../../src/protocol/jsonrpc.ts";
import { JsonRpcLineReader } from "../../src/transports/lines.ts";

function resultLine(sizeMiB: number): Buffer {
	return Buffer.from(
		`${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { text: "x".repeat(sizeMiB * 1024 * 1024) } })}\n`,
	);
}

function readerFor(expectedMessages: number) {
	let received = 0;
	const reader = new JsonRpcLineReader({
		onMessage: (_message: JsonRpcMessage) => received++,
		onError: (error) => {
			throw error;
		},
	});
	return {
		reader,
		finish() {
			reader.end();
			assert.equal(received, expectedMessages);
		},
	};
}

function copyVolume(run: () => void): { concatCalls: number; copiedBytes: number } {
	const original = Buffer.concat;
	let concatCalls = 0;
	let copiedBytes = 0;
	Buffer.concat = (chunks, totalLength) => {
		const buffer = original(chunks, totalLength);
		concatCalls++;
		copiedBytes += buffer.length;
		return buffer;
	};
	try {
		run();
		return { concatCalls, copiedBytes };
	} finally {
		Buffer.concat = original;
	}
}

function medianTime(run: () => void): number {
	const samples: number[] = [];
	for (let index = 0; index < 9; index++) {
		const started = performance.now();
		run();
		if (index >= 2) samples.push(performance.now() - started);
	}
	return samples.sort((a, b) => a - b)[Math.floor(samples.length / 2)];
}

async function pipeTime(sizeMiB: number): Promise<number> {
	const { reader, finish } = readerFor(1);
	const started = performance.now();
	const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--produce", String(sizeMiB)], {
		stdio: ["ignore", "pipe", "inherit"],
	});
	const closed = once(child, "close");
	try {
		for await (const chunk of child.stdout) reader.readStdout(chunk);
		const [code] = await closed;
		assert.equal(code, 0);
		finish();
		return performance.now() - started;
	} finally {
		if (child.exitCode === null) child.kill("SIGKILL");
	}
}

if (process.argv[2] === "--produce") {
	const sizeMiB = Number(process.argv[3]);
	assert.ok(sizeMiB === 4 || sizeMiB === 12);
	const data = resultLine(sizeMiB);
	for (let start = 0; start < data.length; start += 64 * 1024) {
		if (!process.stdout.write(data.subarray(start, start + 64 * 1024))) await once(process.stdout, "drain");
	}
} else {
	const rows: Record<string, unknown>[] = [];
	for (const sizeMiB of [4, 12]) {
		const data = resultLine(sizeMiB);
		const run = () => {
			const { reader, finish } = readerFor(1);
			for (let start = 0; start < data.length; start += 64 * 1024) {
				reader.readStdout(data.subarray(start, start + 64 * 1024));
			}
			finish();
		};
		rows.push({
			kind: "parser",
			sizeMiB,
			wireBytes: data.length,
			chunkBytes: 64 * 1024,
			...copyVolume(run),
			medianMs: medianTime(run),
		});
		const samples: number[] = [];
		for (let sample = 0; sample < 5; sample++) samples.push(await pipeTime(sizeMiB));
		rows.push({ kind: "subprocess", sizeMiB, samplesMs: samples, medianMs: samples.sort((a, b) => a - b)[2] });
	}
	const small = Buffer.from('{"jsonrpc":"2.0","id":1,"result":{}}\n');
	const runSmall = () => {
		const { reader, finish } = readerFor(20_000);
		for (let index = 0; index < 20_000; index++) reader.readStdout(small);
		finish();
	};
	rows.push({ kind: "small-complete-lines", count: 20_000, ...copyVolume(runSmall), medianMs: medianTime(runSmall) });
	console.log(
		JSON.stringify(
			{ label: process.argv[2] ?? "current", node: process.version, platform: process.platform, rows },
			null,
			2,
		),
	);
}
