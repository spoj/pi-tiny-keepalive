import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const KEY = "pi-tiny-keepalive";
const DEFAULT_IDLE_MINUTES = 30;

const keepaliveTool = Type.Object({
	action: Type.Union([Type.Literal("arm"), Type.Literal("disarm")]),
	idle_minutes: Type.Optional(
		Type.Integer({ minimum: 1, description: `Idle minutes before each keepalive message (default ${DEFAULT_IDLE_MINUTES})` }),
	),
});

export default function piTinyKeepalive(pi: ExtensionAPI): void {
	let idleMinutes: number | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let failure: string | undefined;

	function setArmed(ctx: ExtensionContext, minutes: number | undefined): void {
		idleMinutes = minutes;
		clearTimeout(timer);
		ctx.ui.setStatus(KEY, minutes === undefined ? undefined : `keepalive:${minutes}m`);
	}

	function schedule(ctx: ExtensionContext): void {
		const minutes = idleMinutes;
		clearTimeout(timer);
		if (minutes === undefined) return;
		timer = setTimeout(() => {
			// Work outside a run, such as compaction, ends without agent_settled, so try again later.
			if (!ctx.isIdle()) return schedule(ctx);
			const now = `${new Date().toISOString().slice(0, 16)}Z`;
			const text = `keepalive: idle ${minutes}m, now ${now}${failure ? `; last turn failed: ${failure}` : ""}`;
			pi.sendMessage({ customType: KEY, content: text, display: true }, { deliverAs: "steer", triggerTurn: true });
		}, minutes * 60_000);
		timer.unref();
	}

	pi.registerTool({
		name: "keepalive",
		label: "Keepalive",
		description:
			"Arms or disarms keepalive. Once armed, it stays on until you disarm it or the user sends a message or interrupts a turn. Each time the session has been idle for idle_minutes, a keepalive message wakes you.",
		promptSnippet: "Wake this session up while working unattended",
		promptGuidelines: [
			"Arm keepalive when the user wants you to keep working without them; disarm it when the task is done or you need the user.",
			"On a keepalive message, check whatever you were waiting for and continue if you can; otherwise end your turn.",
		],
		parameters: keepaliveTool,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const minutes = params.action === "arm" ? (params.idle_minutes ?? DEFAULT_IDLE_MINUTES) : undefined;
			setArmed(ctx, minutes);
			return { content: [{ type: "text", text: minutes ? `Keepalive armed (${minutes} idle minutes).` : "Keepalive disarmed." }], details: undefined };
		},
	});

	// Interactive and RPC input comes from the user or a program acting as the user; extensions use source "extension".
	pi.on("input", (event, ctx) => {
		if (event.source !== "extension") setArmed(ctx, undefined);
	});
	pi.on("user_bash", (_event, ctx) => setArmed(ctx, undefined));

	pi.on("agent_start", () => clearTimeout(timer));

	pi.on("agent_end", (event, ctx) => {
		// The run's signal marks a user interruption, including Escape during a tool call.
		if (ctx.signal?.aborted) setArmed(ctx, undefined);
		const last = event.messages.at(-1);
		failure = last?.role === "assistant" && last.stopReason === "error" ? last.errorMessage : undefined;
	});

	pi.on("agent_settled", (_event, ctx) => schedule(ctx));

	pi.on("session_shutdown", (_event, ctx) => setArmed(ctx, undefined));
}
