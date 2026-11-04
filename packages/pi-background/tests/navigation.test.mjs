import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { createJiti } from "jiti";
import { Editor, TuiMainScreen, visibleWidth } from "@earendil-works/pi-tui";

const { default: background } = await createJiti(import.meta.url).import("../extensions/background.ts");
const down = "\x1b[B";
const up = "\x1b[A";
const right = "\x1b[C";
const enter = "\r";
const escape = "\x1b";
const theme = { fg: (_color, text) => text, italic: (text) => text };

async function waitFor(condition) {
	const deadline = Date.now() + 5000;
	while (!condition()) {
		assert.ok(Date.now() < deadline, "condition was not reached within 5 seconds");
		await delay(10);
	}
}

async function setup(t, settings = {}) {
	const handlers = new Map();
	const tools = new Map();
	const commands = new Map();
	const listeners = new Set();
	const widgets = new Map();
	const completions = [];
	let editorText = "";
	const editor = {
		getText: () => editorText,
		setText: (text) => { editorText = text; },
		handleInput: (data) => { editorText += data; },
		onCtrlD() {},
		render: () => [], invalidate() {},
	};
	const tui = new TuiMainScreen({ rows: 24, columns: 100, write() {}, hideCursor() {}, showCursor() {} });
	tui.requestRender = () => {};
	tui.setFocus(editor);
	const ctx = {
		mode: "tui", hasUI: true, cwd: process.cwd(),
		sessionManager: { getBranch: () => [] },
		ui: {
			getEditorText: () => editorText,
			notify: (message) => { throw new Error(message); },
			onTerminalInput(handler) { listeners.add(handler); return () => listeners.delete(handler); },
			setWidget(name, factory) { widgets.set(name, factory(tui, theme)); },
			custom(factory) {
				return new Promise((resolve) => {
					const previous = tui.focusedComponent;
					const component = factory(tui, theme, {}, () => {
						component.dispose?.();
						tui.setFocus(previous);
						resolve();
					});
					tui.setFocus(component);
				});
			},
		},
	};
	const pi = {
		on(event, handler) { const list = handlers.get(event) ?? []; list.push(handler); handlers.set(event, list); },
		getSettings: () => settings,
		getAllTools: () => [],
		registerTool: (tool) => tools.set(tool.name, tool),
		registerCommand: (name, command) => commands.set(name, command),
		registerMessageRenderer() {},
		sendMessage: (message) => completions.push(message),
	};
	background(pi);
	const emit = async (event) => { for (const handler of handlers.get(event) ?? []) await handler({}, ctx); };
	const key = async (data) => {
		for (const handler of listeners) if (handler(data)?.consume) return true;
		tui.focusedComponent?.handleInput?.(data);
		await Promise.resolve();
		return false;
	};
	await emit("session_start");
	t.after(async () => {
		if (tui.focusedComponent !== editor) await key(escape);
		await emit("session_shutdown");
		await delay(50);
	});
	return {
		ctx, tui, editor, listeners, commands, completions, key, emit,
		render: (width = 100) => widgets.get("background-jobs").render(width).join("\n"),
		async start(command = "printf 'live-output\\n'; sleep 30") {
			const result = await tools.get("bg_run").execute("test", { command }, undefined, undefined, ctx);
			return result.details;
		},
	};
}

test("Down focuses running jobs; Enter opens the selected job's real output", async (t) => {
	const h = await setup(t);
	const job = await h.start();
	await waitFor(() => {
		try { return readFileSync(job.log, "utf8").includes("live-output"); }
		catch (error) { if (error.code !== "ENOENT") throw error; return false; }
	});
	assert.equal(await h.key(down), true);
	assert.notEqual(h.tui.focusedComponent, h.editor);
	assert.match(h.render(), /› bg1/);
	await h.key(enter);
	assert.match(h.tui.focusedComponent.render(100).join("\n"), /live-output/);
	await h.key(escape);
	assert.equal(h.tui.focusedComponent, h.editor);
});

test("all running jobs remain reachable beyond the collapsed widget limit", async (t) => {
	const h = await setup(t);
	h.tui.terminal.rows = 8;
	for (let i = 0; i < 7; i++) await h.start();
	assert.match(h.render(), /7 jobs/);
	await h.key(down);
	for (let i = 0; i < 6; i++) await h.key(down);
	assert.match(h.render(), /› bg7/);
	assert.ok(h.render().split("\n").length <= 3);
	for (const line of h.render(12).split("\n")) assert.ok(visibleWidth(line) <= 12);
	await h.key("k");
	assert.match(h.render(), /› bg6/);
	await h.key(escape);
	assert.equal(h.tui.focusedComponent, h.editor);
});

test("typing and Up from the first job restore the editor", async (t) => {
	const h = await setup(t);
	await h.start();
	await h.key(down);
	await h.key(up);
	assert.equal(h.tui.focusedComponent, h.editor);
	await h.key(down);
	await h.key("x");
	assert.equal(h.editor.getText(), "x");
	assert.equal(h.tui.focusedComponent, h.editor);
});

test("no jobs, nonempty prompts, dialogs and key releases do not activate navigation", async (t) => {
	const h = await setup(t);
	assert.equal(await h.key(down), false);
	h.editor.setText("");
	await h.start();
	h.editor.setText("draft");
	assert.equal(await h.key(down), false);
	h.editor.setText("");
	const dialog = { handleInput() {} };
	h.tui.setFocus(dialog);
	assert.equal(await h.key(down), false);
	assert.equal(h.tui.focusedComponent, dialog);
	h.tui.setFocus(h.editor);
	assert.equal(await h.key("\x1b[57353;1:3u"), false);
	assert.equal(h.tui.focusedComponent, h.editor);
});

test("Right opens jobs even if an earlier widget consumes Down", async (t) => {
	const h = await setup(t);
	await h.start();
	const jobListeners = [...h.listeners];
	h.listeners.clear();
	h.listeners.add((data) => data === down && h.tui.focusedComponent === h.editor ? { consume: true } : undefined);
	for (const listener of jobListeners) h.listeners.add(listener);
	await h.key(down);
	assert.equal(h.tui.focusedComponent, h.editor);
	assert.equal(await h.key(right), true);
	assert.notEqual(h.tui.focusedComponent, h.editor);
	assert.match(h.render(), /› bg1/);
});

test("finishing the focused job releases focus when no running jobs remain", async (t) => {
	const h = await setup(t);
	await h.start("sleep 0.2");
	await h.key(down);
	assert.notEqual(h.tui.focusedComponent, h.editor);
	await waitFor(() => h.completions.length > 0);
	h.render();
	assert.equal(h.tui.focusedComponent, h.editor);
});

test("shutdown unregisters input and releases widget focus", async (t) => {
	const h = await setup(t);
	await h.start();
	await h.key(down);
	await h.emit("session_shutdown");
	assert.equal(h.listeners.size, 0);
	assert.equal(h.tui.focusedComponent, h.editor);
});

test("hidden widgets do not capture arrow keys", async (t) => {
	const h = await setup(t, { background: { jobs: "off" } });
	await h.start();
	assert.equal(await h.key(down), false);
});

test("completion beneath a real overlay restores the prompt when the overlay closes", async (t) => {
	const h = await setup(t);
	await h.start("sleep 0.2");
	await h.key(down);
	const overlay = { render: () => ["overlay"], invalidate() {}, handleInput() {} };
	const handle = h.tui.showOverlay(overlay);
	await waitFor(() => h.completions.length > 0);
	h.render();
	assert.equal(h.tui.getFocusedComponent(), overlay);
	handle.hide();
	h.render();
	assert.equal(h.tui.getFocusedComponent(), h.editor);
	await h.key("x");
	assert.equal(h.editor.getText(), "x");
});

test("native editable dialogs do not activate jobs, including an empty modal", async (t) => {
	const h = await setup(t);
	await h.start();
	const modal = new Editor(h.tui, { borderColor: (text) => text, selectList: {} });
	modal.setText("modal draft");
	h.tui.setFocus(modal);
	assert.equal(await h.key(down), false);
	assert.equal(h.tui.getFocusedComponent(), modal);
	assert.equal(modal.getText(), "modal draft");
	modal.setText("");
	assert.equal(await h.key(right), false);
	assert.equal(h.tui.getFocusedComponent(), modal);
});
