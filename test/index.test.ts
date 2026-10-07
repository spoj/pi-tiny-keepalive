import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createAssistantMessageEventStream,
	InMemoryCredentialStore,
	InMemoryModelsStore,
	type AssistantMessage,
	type Context,
} from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import piTinyKeepalive from "../src/index.ts";

const MINUTE = 60_000;

function setup() {
	const pi = { registerTool: vi.fn(), on: vi.fn(), sendMessage: vi.fn() };
	piTinyKeepalive(pi as never);
	const ctx = { isIdle: vi.fn(() => true), signal: undefined as AbortSignal | undefined, ui: { setStatus: vi.fn() } };
	const handlers = Object.fromEntries(pi.on.mock.calls.map(([name, handler]) => [name, handler]));
	const tool = pi.registerTool.mock.calls[0][0];
	const arm = (idle_minutes?: number) => tool.execute("call-1", { action: "arm", idle_minutes }, undefined, undefined, ctx);
	const settle = (last: object = { role: "assistant", stopReason: "stop" }) => {
		handlers.agent_end({ messages: [{ role: "user" }, last] }, ctx);
		handlers.agent_settled({}, ctx);
	};
	const texts = () => pi.sendMessage.mock.calls.map(([message]) => message.content);
	return { pi, ctx, handlers, tool, arm, settle, texts };
}

describe("keepalive extension", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("registers one tool and the lifecycle handlers", () => {
		const { pi, tool } = setup();
		expect(pi.registerTool).toHaveBeenCalledOnce();
		expect(tool.name).toBe("keepalive");
		expect(tool.parameters.required).toEqual(["action"]);
		expect(pi.on.mock.calls.map(([name]) => name)).toEqual([
			"input", "user_bash", "agent_start", "agent_end", "agent_settled", "session_shutdown",
		]);
	});

	it("wakes an idle session after each idle period while armed", async () => {
		const { pi, ctx, handlers, arm, settle, texts } = setup();
		const result = await arm(5);
		expect(result.content[0].text).toContain("5 idle minutes");
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("pi-tiny-keepalive", "keepalive:5m");

		settle();
		vi.advanceTimersByTime(5 * MINUTE - 1);
		expect(pi.sendMessage).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(pi.sendMessage).toHaveBeenCalledOnce();
		expect(pi.sendMessage.mock.calls[0][0]).toMatchObject({ customType: "pi-tiny-keepalive", display: true });
		expect(pi.sendMessage.mock.calls[0][1]).toEqual({ deliverAs: "steer", triggerTurn: true });
		expect(texts()[0]).toMatch(/^keepalive: idle 5m, now \d{4}-\d\d-\d\dT\d\d:\d\dZ$/);

		handlers.agent_start({}, ctx);
		settle();
		vi.advanceTimersByTime(5 * MINUTE);
		expect(pi.sendMessage).toHaveBeenCalledTimes(2);
	});

	it("defaults to 30 idle minutes and reports a failed last turn", async () => {
		const { pi, arm, settle, texts } = setup();
		await arm();
		settle({ role: "assistant", stopReason: "error", errorMessage: "429 Too Many Requests" });
		vi.advanceTimersByTime(30 * MINUTE);
		expect(pi.sendMessage).toHaveBeenCalledOnce();
		expect(texts()[0]).toMatch(/^keepalive: idle 30m, now .+; last turn failed: 429 Too Many Requests$/);
	});

	it("stays quiet unless armed", () => {
		const { pi, settle } = setup();
		settle();
		vi.advanceTimersByTime(24 * 60 * MINUTE);
		expect(pi.sendMessage).not.toHaveBeenCalled();
	});

	it("cancels the pending keepalive when a run starts", async () => {
		const { pi, ctx, handlers, arm, settle } = setup();
		await arm(5);
		settle();
		handlers.agent_start({}, ctx);
		vi.advanceTimersByTime(10 * MINUTE);
		expect(pi.sendMessage).not.toHaveBeenCalled();
	});

	it("waits another idle period when the session is busy outside a run", async () => {
		const { pi, ctx, arm, settle } = setup();
		await arm(5);
		settle();
		ctx.isIdle.mockReturnValue(false);
		vi.advanceTimersByTime(5 * MINUTE);
		expect(pi.sendMessage).not.toHaveBeenCalled();
		ctx.isIdle.mockReturnValue(true);
		vi.advanceTimersByTime(5 * MINUTE);
		expect(pi.sendMessage).toHaveBeenCalledOnce();
	});

	it("is disarmed by user input and user bash but not extension input", async () => {
		for (const disarm of [
			(handlers: Record<string, Function>, ctx: object) => handlers.input({ source: "interactive" }, ctx),
			(handlers: Record<string, Function>, ctx: object) => handlers.input({ source: "rpc" }, ctx),
			(handlers: Record<string, Function>, ctx: object) => handlers.user_bash({ command: "ls" }, ctx),
		]) {
			const { pi, ctx, handlers, arm, settle } = setup();
			await arm(5);
			handlers.input({ source: "extension" }, ctx);
			disarm(handlers, ctx);
			expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("pi-tiny-keepalive", undefined);
			settle();
			vi.advanceTimersByTime(10 * MINUTE);
			expect(pi.sendMessage).not.toHaveBeenCalled();
		}

		const { pi, ctx, handlers, arm, settle } = setup();
		await arm(5);
		handlers.input({ source: "extension" }, ctx);
		settle();
		vi.advanceTimersByTime(5 * MINUTE);
		expect(pi.sendMessage).toHaveBeenCalledOnce();
	});

	it("is disarmed by an interrupted run", async () => {
		const { pi, ctx, arm, settle } = setup();
		await arm(5);
		ctx.signal = AbortSignal.abort();
		settle({ role: "assistant", stopReason: "aborted" });
		vi.advanceTimersByTime(10 * MINUTE);
		expect(pi.sendMessage).not.toHaveBeenCalled();
	});

	it("clears the pending keepalive on disarm and session changes", async () => {
		const { pi, ctx, handlers, tool, arm, settle } = setup();
		await arm(5);
		settle();
		const result = await tool.execute("call-2", { action: "disarm" }, undefined, undefined, ctx);
		expect(result.content[0].text).toBe("Keepalive disarmed.");
		vi.advanceTimersByTime(10 * MINUTE);

		await arm(5);
		settle();
		handlers.session_shutdown({}, ctx);
		vi.advanceTimersByTime(10 * MINUTE);

		expect(pi.sendMessage).not.toHaveBeenCalled();
	});
});

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const close of cleanups.splice(0)) await close();
	vi.restoreAllMocks();
});

async function setupAgent() {
	const cwd = mkdtempSync(join(tmpdir(), "pi-tiny-keepalive-"));
	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
	const resourceLoader = new DefaultResourceLoader({
		cwd, agentDir: cwd, settingsManager,
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		extensionFactories: [piTinyKeepalive],
	});
	await resourceLoader.reload();
	const model = getModel("anthropic", "claude-sonnet-4-5")!;
	// session.prompt() checks for a key even though the stream below never calls the provider.
	const credentials = new InMemoryCredentialStore();
	await credentials.modify(model.provider, async () => ({ type: "api_key", key: "test" }));
	const modelRuntime = await ModelRuntime.create({
		credentials,
		modelsStore: new InMemoryModelsStore(),
		modelsPath: null,
		refreshOnCreate: false,
	});
	const { session } = await createAgentSession({
		cwd, agentDir: cwd, model, modelRuntime, settingsManager, resourceLoader,
		sessionManager: SessionManager.inMemory(cwd), tools: ["keepalive"],
	});
	const errors: unknown[] = [];
	await session.bindExtensions({ onError: (error) => { errors.push(error); } });
	const requests: Context[] = [];
	const streams: ReturnType<typeof createAssistantMessageEventStream>[] = [];
	const reply = (index: number, content: AssistantMessage["content"], stopReason: "stop" | "toolUse" | "error" | "aborted" = "stop") => {
		const message: AssistantMessage = {
			role: "assistant", api: model.api, provider: model.provider, model: model.id,
			content, stopReason, timestamp: Date.now(),
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			...(stopReason === "error" ? { errorMessage: "529 overloaded" } : {}),
		};
		if (stopReason === "stop" || stopReason === "toolUse") streams[index].push({ type: "done", reason: stopReason, message });
		else streams[index].push({ type: "error", reason: stopReason, error: message });
	};
	session.agent.streamFunction = (_model, context, options) => {
		const index = streams.length;
		requests.push(structuredClone(context));
		const stream = createAssistantMessageEventStream();
		streams.push(stream);
		options?.signal?.addEventListener("abort", () => reply(index, [], "aborted"), { once: true });
		return stream;
	};
	const arm = (index: number) =>
		reply(index, [{ type: "toolCall", id: `call-${index}`, name: "keepalive", arguments: { action: "arm", idle_minutes: 1 } }], "toolUse");
	// Keepalive timers are real; run the pending one now instead of waiting a minute.
	const timeouts = vi.spyOn(globalThis, "setTimeout");
	const clears = vi.spyOn(globalThis, "clearTimeout");
	const fireKeepalive = () => {
		const cleared = new Set(clears.mock.calls.map(([handle]) => handle));
		const pending = timeouts.mock.calls
			.map(([callback, delay], index) => ({ callback, delay, handle: timeouts.mock.results[index].value }))
			.filter(({ delay, handle }) => delay === MINUTE && !cleared.has(handle));
		expect(pending.length).toBeLessThanOrEqual(1);
		if (!pending.length) return false;
		clearTimeout(pending[0].handle);
		(pending[0].callback as () => void)();
		return true;
	};
	cleanups.push(async () => {
		await session.abort();
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		session.dispose();
		rmSync(cwd, { recursive: true, force: true });
		expect(errors).toEqual([]);
	});
	return { session, requests, streams, reply, arm, fireKeepalive };
}

describe("keepalive through AgentSession", () => {
	it("arms from a tool call, wakes the idle session, and is disarmed by the user", async () => {
		const { session, requests, streams, reply, arm, fireKeepalive } = await setupAgent();
		const first = session.prompt("work unattended");
		await vi.waitFor(() => expect(streams).toHaveLength(1));
		arm(0);
		await vi.waitFor(() => expect(streams).toHaveLength(2));
		reply(1, [{ type: "text", text: "waiting" }]);
		await first;
		await vi.waitFor(() => expect(session.isIdle).toBe(true));

		expect(fireKeepalive()).toBe(true);
		await vi.waitFor(() => expect(streams).toHaveLength(3));
		expect(JSON.stringify(requests[2])).toMatch(/keepalive: idle 1m, now /);
		reply(2, [], "error");
		await vi.waitFor(() => expect(session.isIdle).toBe(true));

		expect(fireKeepalive()).toBe(true);
		await vi.waitFor(() => expect(streams).toHaveLength(4));
		expect(JSON.stringify(requests[3])).toContain("last turn failed: 529 overloaded");
		reply(3, [{ type: "text", text: "still waiting" }]);
		await vi.waitFor(() => expect(session.isIdle).toBe(true));

		const second = session.prompt("I'm back");
		await vi.waitFor(() => expect(streams).toHaveLength(5));
		reply(4, [{ type: "text", text: "hello" }]);
		await second;
		await vi.waitFor(() => expect(session.isIdle).toBe(true));
		expect(fireKeepalive()).toBe(false);
	});

	it("is disarmed when the user interrupts a run", async () => {
		const { session, streams, arm, fireKeepalive } = await setupAgent();
		const run = session.prompt("work unattended");
		await vi.waitFor(() => expect(streams).toHaveLength(1));
		arm(0);
		await vi.waitFor(() => expect(streams).toHaveLength(2));
		await session.abort();
		await run;
		await vi.waitFor(() => expect(session.isIdle).toBe(true));
		expect(fireKeepalive()).toBe(false);
	});
});
