import { afterEach, describe, expect, it, vi } from "vitest";
import type { JsonRpcMessage } from "../src/protocol/jsonrpc.ts";
import { JsonRpcLineReader } from "../src/transports/lines.ts";

function createReader(maxMessageBytes?: number) {
	const messages: JsonRpcMessage[] = [];
	const errors: unknown[] = [];
	const reader = new JsonRpcLineReader({
		maxMessageBytes,
		onMessage: (message) => messages.push(message),
		onError: (error) => errors.push(error),
	});
	return { reader, messages, errors };
}

const message = { jsonrpc: "2.0", id: 1, result: { text: "中文 é 👨‍👩‍👧‍👦" } } as const;
const line = Buffer.from(`${JSON.stringify(message)}\n`);

afterEach(() => vi.restoreAllMocks());

describe("JsonRpcLineReader framing", () => {
	// Regression coverage for https://github.com/earendil-works/pi/issues/11761.
	it("decodes a message split at every byte boundary, including inside UTF-8 characters", () => {
		for (let split = 0; split <= line.length; split++) {
			const { reader, messages, errors } = createReader();
			reader.readStdout(line.subarray(0, split));
			reader.readStdout(line.subarray(split));
			reader.end();
			expect(messages).toEqual([message]);
			expect(errors).toEqual([]);
		}
	});

	it("accepts byte-at-a-time input and CRLF split between chunks", () => {
		const { reader, messages, errors } = createReader();
		const bytes = Buffer.from(`${JSON.stringify(message)}\r\n`);
		for (const byte of bytes) reader.readStdout(Uint8Array.of(byte));
		reader.end();
		expect(messages).toEqual([message]);
		expect(errors).toEqual([]);
	});

	it("processes multiple lines, blank lines, and a final partial message", () => {
		const { reader, messages, errors } = createReader();
		const first = JSON.stringify({ jsonrpc: "2.0", method: "first" });
		const second = JSON.stringify({ jsonrpc: "2.0", id: 2, result: {} });
		reader.readStdout(Buffer.from(`${first.slice(0, 5)}`));
		reader.readStdout(Buffer.from(`${first.slice(5)}\n\r\n \t\n${second}\n${first.slice(0, 9)}`));
		reader.readStdout(Buffer.from(`${first.slice(9)}\n`));
		reader.end();
		expect(messages).toEqual([JSON.parse(first), JSON.parse(second), JSON.parse(first)]);
		expect(errors).toEqual([]);
	});

	it("respects Uint8Array offsets without reading bytes outside the view", () => {
		const { reader, messages, errors } = createReader();
		const bytes = Buffer.concat([Buffer.from("ignored\n"), line, Buffer.from("invalid\n")]);
		reader.readStdout(new Uint8Array(bytes.buffer, bytes.byteOffset + 8, line.length));
		reader.end();
		expect(messages).toEqual([message]);
		expect(errors).toEqual([]);
	});

	it("reports invalid JSON and JSON-RPC lines and continues to the next message", () => {
		const { reader, messages, errors } = createReader();
		reader.readStdout(Buffer.from("not-json\n{}\n"));
		reader.readStdout(line);
		reader.end();
		expect(errors).toHaveLength(2);
		expect(messages).toEqual([message]);
	});

	it.each([false, true])("accepts an exact-limit message, fragmented: %s", (fragmented) => {
		const { reader, messages, errors } = createReader(line.length - 1);
		if (fragmented) {
			reader.readStdout(line.subarray(0, line.length - 1));
			reader.readStdout(line.subarray(line.length - 1));
		} else reader.readStdout(line);
		reader.end();
		expect(messages).toEqual([message]);
		expect(errors).toEqual([]);
	});

	it("counts the CR byte toward the existing message-size limit", () => {
		const { reader, messages, errors } = createReader(line.length - 1);
		reader.readStdout(Buffer.from(`${JSON.stringify(message)}\r`));
		reader.readStdout(Buffer.from("\n"));
		expect(messages).toEqual([]);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toHaveProperty("message", `MCP stdio message exceeds ${line.length - 1} bytes`);
	});

	it.each([false, true])(
		"skips a completed oversized line and processes the next one, fragmented: %s",
		(fragmented) => {
			const { reader, messages, errors } = createReader(128);
			const oversized = Buffer.from("x".repeat(129));
			if (fragmented) reader.readStdout(oversized.subarray(0, 64));
			reader.readStdout(Buffer.concat([fragmented ? oversized.subarray(64) : oversized, Buffer.from("\n"), line]));
			reader.end();
			expect(errors).toHaveLength(1);
			expect(errors[0]).toHaveProperty("message", "MCP stdio message exceeds 128 bytes");
			expect(messages).toEqual([message]);
		},
	);

	it("drops an incomplete oversized prefix and recovers on the following chunk", () => {
		const { reader, messages, errors } = createReader(128);
		reader.readStdout(Buffer.from("x".repeat(64)));
		reader.readStdout(Buffer.from("x".repeat(65)));
		reader.readStdout(line);
		reader.end();
		expect(errors).toHaveLength(1);
		expect(messages).toEqual([message]);
	});

	it("reports a nonblank incomplete final line once and clears pending data", () => {
		const { reader, messages, errors } = createReader();
		reader.readStdout(line.subarray(0, 10));
		reader.readStdout(line.subarray(10, line.length - 1));
		reader.end();
		reader.end();
		expect(messages).toEqual([]);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toHaveProperty("message", "MCP stdio server closed with an incomplete JSON-RPC message");
	});

	it("ignores empty chunks and whitespace-only final data", () => {
		const { reader, messages, errors } = createReader();
		reader.readStdout(Buffer.alloc(0));
		reader.readStdout(Buffer.from(" \t"));
		reader.readStdout(Buffer.alloc(0));
		reader.readStdout(Buffer.from("\r"));
		reader.end();
		reader.end();
		expect(messages).toEqual([]);
		expect(errors).toEqual([]);
	});

	it("keeps stderr tail and callback behavior unchanged", () => {
		const chunks: string[] = [];
		const reader = new JsonRpcLineReader({
			maxStderrBytes: 5,
			onStderr: (chunk) => chunks.push(chunk),
			onMessage: () => {},
			onError: () => {},
		});
		reader.readStderr(Buffer.from("abc"));
		reader.readStderr(Uint8Array.from(Buffer.from("defg")));
		expect(reader.stderr).toBe("cdefg");
		expect(chunks).toEqual(["abc", "defg"]);
	});
});

describe("JsonRpcLineReader buffering work", () => {
	// #11761: assert work counts rather than machine-dependent timing thresholds.
	it.each([4, 12])("copies a %i MiB fragmented result only once and never rescans its prefix", (sizeMiB) => {
		const data = Buffer.from(
			`${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { text: "x".repeat(sizeMiB * 1024 * 1024) } })}\n`,
		);
		const { reader, messages, errors } = createReader();
		const concat = vi.spyOn(Buffer, "concat");
		const indexOf = vi.spyOn(Buffer.prototype, "indexOf");
		for (let start = 0; start < data.length; start += 64 * 1024) {
			reader.readStdout(data.subarray(start, start + 64 * 1024));
		}
		reader.end();
		const concatCalls = concat.mock.calls.length;
		const copiedBytes = concat.mock.results.reduce(
			(sum, result) => sum + (result.type === "return" ? result.value.length : 0),
			0,
		);
		const scannedWindowBytes = indexOf.mock.calls.reduce((sum, args, index) => {
			if (args[0] !== 0x0a) return sum;
			return sum + indexOf.mock.contexts[index].length - Number(args[1] ?? 0);
		}, 0);
		concat.mockRestore();
		indexOf.mockRestore();
		expect(errors).toEqual([]);
		expect(messages).toEqual([{ jsonrpc: "2.0", id: 1, result: { text: "x".repeat(sizeMiB * 1024 * 1024) } }]);
		expect(concatCalls).toBe(1);
		expect(copiedBytes).toBe(data.length - 1);
		expect(scannedWindowBytes).toBeLessThanOrEqual(data.length);
	});

	it("does not concatenate complete messages already contained in a chunk", () => {
		const { reader, messages, errors } = createReader();
		const chunk = Buffer.concat([line, line, line]);
		const concat = vi.spyOn(Buffer, "concat");
		reader.readStdout(chunk);
		reader.end();
		const calls = concat.mock.calls.length;
		concat.mockRestore();
		expect(messages).toHaveLength(3);
		expect(errors).toEqual([]);
		expect(calls).toBe(0);
	});
});
