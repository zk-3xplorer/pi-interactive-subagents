/**
 * cmux surface layer — the only terminal multiplexer this extension supports.
 *
 * The first subagent gets a right-hand split from the caller. Later subagents
 * open as named tabs in that same pane, avoiding progressively narrower panes.
 */
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const execFileAsync = promisify(execFile);
const commandAvailability = new Map<string, boolean>();
let subagentPane: string | null = null;

export interface PollResult {
  reason: "done" | "sentinel" | "error";
  exitCode: number;
  errorMessage?: string;
}

interface CmuxFocusSnapshot {
  windowRef?: string;
  workspaceRef?: string;
  surfaceRef?: string;
  paneRef?: string;
}

interface CmuxFocusGuardDecision {
  desired: CmuxFocusSnapshot;
  restoreTo?: CmuxFocusSnapshot;
}

interface CmuxIdentifySnapshot {
  focused: CmuxFocusSnapshot | null;
  caller: CmuxFocusSnapshot | null;
}

interface CmuxCreatedSurface {
  surface: string;
  paneRef?: string;
}

function hasCommand(command: string): boolean {
  const cached = commandAvailability.get(command);
  if (cached !== undefined) return cached;
  try {
    execFileSync("sh", ["-c", `command -v ${command}`], { stdio: "ignore" });
    commandAvailability.set(command, true);
    return true;
  } catch {
    commandAvailability.set(command, false);
    return false;
  }
}

export function isCmuxAvailable(): boolean {
  return !!process.env.CMUX_SOCKET_PATH && !!process.env.CMUX_SURFACE_ID && hasCommand("cmux");
}

export function isMuxAvailable(): boolean {
  return isCmuxAvailable();
}

export function muxSetupHint(): string {
  return "Start pi inside cmux (`cmux .`, then run `pi`).";
}

function requireCmux(): void {
  if (!isCmuxAvailable()) throw new Error(`cmux is required for subagents. ${muxSetupHint()}`);
}

export function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

function parseCreatedSurface(output: string, command: string): CmuxCreatedSurface {
  const surface = output.match(/surface:\d+/)?.[0];
  if (!surface) throw new Error(`Unexpected cmux ${command} output: ${output}`);
  return { surface, paneRef: output.match(/pane:\d+/)?.[0] };
}

function parseFocusSnapshot(value: unknown): CmuxFocusSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const windowRef = typeof record.window_ref === "string" ? record.window_ref : undefined;
  const workspaceRef = typeof record.workspace_ref === "string" ? record.workspace_ref : undefined;
  const surfaceRef = typeof record.surface_ref === "string" ? record.surface_ref : undefined;
  const paneRef = typeof record.pane_ref === "string" ? record.pane_ref : undefined;
  return windowRef || workspaceRef || surfaceRef || paneRef
    ? { windowRef, workspaceRef, surfaceRef, paneRef }
    : null;
}

function parseIdentifySnapshot(value: string): CmuxIdentifySnapshot {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return {
      focused: parseFocusSnapshot(parsed.focused),
      caller: parseFocusSnapshot(parsed.caller),
    };
  } catch {
    return { focused: null, caller: null };
  }
}

function identify(args: string[] = []): CmuxIdentifySnapshot {
  try {
    return parseIdentifySnapshot(execFileSync("cmux", ["identify", ...args], { encoding: "utf8" }));
  } catch {
    return { focused: null, caller: null };
  }
}

function sameFocus(a: CmuxFocusSnapshot, b: CmuxFocusSnapshot): boolean {
  if (a.surfaceRef && b.surfaceRef) return a.surfaceRef === b.surfaceRef;
  if (a.paneRef && b.paneRef) return a.paneRef === b.paneRef;
  return !!a.workspaceRef && a.workspaceRef === b.workspaceRef;
}

function restoreFocus(snapshot: CmuxFocusSnapshot | null): void {
  if (!snapshot) return;
  const scope: string[] = [];
  if (snapshot.workspaceRef) scope.push("--workspace", snapshot.workspaceRef);
  if (snapshot.windowRef) scope.push("--window", snapshot.windowRef);
  if (snapshot.surfaceRef) {
    execFileSync("cmux", ["focus-panel", "--panel", snapshot.surfaceRef, ...scope], { stdio: "ignore" });
  } else if (snapshot.workspaceRef) {
    execFileSync("cmux", ["select-workspace", "--workspace", snapshot.workspaceRef], { stdio: "ignore" });
  } else if (snapshot.paneRef) {
    execFileSync("cmux", ["focus-pane", "--pane", snapshot.paneRef, ...scope], { stdio: "ignore" });
  }
}

function advanceFocusGuard(
  desired: CmuxFocusSnapshot,
  current: CmuxFocusSnapshot,
  operationWorkspace?: string,
  ownedSurfaces: ReadonlySet<string> = new Set(),
  ownedPanes: ReadonlySet<string> = new Set(),
  canRestore = true,
): CmuxFocusGuardDecision {
  if (sameFocus(desired, current)) return { desired };

  // Destination-only polling cannot distinguish a second cmux focus steal from
  // the user deliberately entering the operation workspace. Correct at most
  // once, then honor all later navigation.
  if (!canRestore) return { desired: current };

  const enteredBackgroundWorkspace =
    !!operationWorkspace &&
    current.workspaceRef === operationWorkspace &&
    desired.workspaceRef !== operationWorkspace;
  const enteredOwnedSurface = !!current.surfaceRef && ownedSurfaces.has(current.surfaceRef);
  const enteredOwnedPane = !!current.paneRef && ownedPanes.has(current.paneRef);

  if (enteredBackgroundWorkspace || enteredOwnedSurface || enteredOwnedPane) {
    return { desired, restoreTo: desired };
  }

  // Focus moved somewhere unrelated to this operation. Treat that as deliberate
  // user navigation and protect the new destination from later cmux events.
  return { desired: current };
}

function startFocusGuard(
  original: CmuxFocusSnapshot | null,
  operationWorkspace: string | undefined,
  ownedSurfaces: Iterable<string | undefined>,
  ownedPanes: Iterable<string | undefined>,
  delays: readonly number[] = [50, 150, 350, 750, 1500],
): void {
  if (!original) return;
  let desired = original;
  let canRestore = true;
  const surfaces = new Set([...ownedSurfaces].filter((value): value is string => !!value));
  const panes = new Set([...ownedPanes].filter((value): value is string => !!value));

  const check = () => {
    const current = identify().focused;
    if (!current) return;
    const decision = advanceFocusGuard(
      desired,
      current,
      operationWorkspace,
      surfaces,
      panes,
      canRestore,
    );
    desired = decision.desired;
    if (decision.restoreTo) {
      canRestore = false;
      try {
        restoreFocus(decision.restoreTo);
      } catch {}
    }
  };

  // cmux can publish focus changes after the mutating CLI command returns.
  // Re-check over a short settling window without blocking pi's event loop.
  check();
  for (const delay of delays) {
    const timer = setTimeout(check, delay);
    timer.unref?.();
  }
}

function renameSurface(surface: string, name: string): void {
  execFileSync("cmux", ["rename-tab", "--surface", surface, "--", name], { encoding: "utf8" });
}

function createSplit(
  name: string,
  direction: "left" | "right" | "up" | "down",
  fromSurface?: string,
): CmuxCreatedSurface {
  const snapshot = identify();
  let created: CmuxCreatedSurface | null = null;
  try {
    const args = ["new-split", direction, "--focus", "false"];
    if (fromSurface) args.push("--surface", fromSurface);
    created = parseCreatedSurface(execFileSync("cmux", args, { encoding: "utf8" }).trim(), "new-split");
    renameSurface(created.surface, name);
    return created;
  } finally {
    startFocusGuard(
      snapshot.focused,
      snapshot.caller?.workspaceRef,
      [created?.surface, fromSurface, snapshot.caller?.surfaceRef],
      [created?.paneRef, snapshot.caller?.paneRef],
    );
  }
}

function treeContainsPane(tree: string, pane: string): boolean {
  return tree.split(/\s+/).includes(pane);
}

function paneExists(pane: string): boolean {
  try {
    return treeContainsPane(execFileSync("cmux", ["tree"], { encoding: "utf8" }), pane);
  } catch {
    return false;
  }
}

function createInPane(name: string, pane: string): CmuxCreatedSurface {
  const snapshot = identify();
  let created: CmuxCreatedSurface | null = null;
  try {
    created = parseCreatedSurface(
      execFileSync("cmux", ["new-surface", "--pane", pane, "--focus", "false"], {
        encoding: "utf8",
      }).trim(),
      "new-surface",
    );
    created.paneRef ??= pane;
    renameSurface(created.surface, name);
    return created;
  } finally {
    startFocusGuard(
      snapshot.focused,
      snapshot.caller?.workspaceRef,
      [created?.surface, snapshot.caller?.surfaceRef],
      [created?.paneRef, pane, snapshot.caller?.paneRef],
    );
  }
}

export function createSurface(name: string): string {
  requireCmux();
  if (subagentPane && paneExists(subagentPane)) return createInPane(name, subagentPane).surface;
  subagentPane = null;
  const created = createSplit(name, "right", process.env.CMUX_SURFACE_ID);
  if (!created.paneRef) {
    const createdSnapshot = identify(["--surface", created.surface]).caller;
    if (createdSnapshot?.surfaceRef === created.surface) created.paneRef = createdSnapshot.paneRef;
  }
  subagentPane = created.paneRef ?? null;
  return created.surface;
}

export function createSurfaceSplit(
  name: string,
  direction: "left" | "right" | "up" | "down",
  fromSurface?: string,
): string {
  requireCmux();
  return createSplit(name, direction, fromSurface).surface;
}

function splitControlSequences(text: string): string[] {
  const chunks: string[] = [];
  let start = 0;
  for (const match of text.matchAll(/\\[nrt]/g)) {
    const slashEnd = match.index + 1;
    chunks.push(text.slice(start, slashEnd));
    start = slashEnd;
  }
  chunks.push(text.slice(start));
  return chunks;
}

export function sendCommand(surface: string, command: string): void {
  requireCmux();
  for (const chunk of splitControlSequences(command)) {
    if (chunk) execFileSync("cmux", ["send", "--surface", surface, chunk], { encoding: "utf8" });
  }
  execFileSync("cmux", ["send", "--surface", surface, "\n"], { encoding: "utf8" });
}

export function sendLongCommand(
  surface: string,
  command: string,
  options?: { scriptPath?: string; scriptPreamble?: string },
): string {
  const scriptPath =
    options?.scriptPath ??
    join(tmpdir(), "pi-subagent-scripts", `cmd-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.sh`);
  mkdirSync(dirname(scriptPath), { recursive: true });
  const parts = ["#!/bin/bash"];
  if (options?.scriptPreamble) parts.push(options.scriptPreamble.trimEnd());
  parts.push(command);
  writeFileSync(scriptPath, parts.join("\n") + "\n", { mode: 0o755 });
  sendCommand(surface, `bash ${shellEscape(scriptPath)}`);
  return scriptPath;
}

export function readScreen(surface: string, lines = 50): string {
  requireCmux();
  return execFileSync("cmux", ["read-screen", "--surface", surface, "--lines", String(lines)], {
    encoding: "utf8",
  });
}

export async function readScreenAsync(surface: string, lines = 50): Promise<string> {
  requireCmux();
  const { stdout } = await execFileAsync(
    "cmux",
    ["read-screen", "--surface", surface, "--lines", String(lines)],
    { encoding: "utf8" },
  );
  return stdout;
}

export function closeSurface(surface: string): void {
  requireCmux();
  const snapshot = identify();
  const target = identify(["--surface", surface]).caller;
  execFileSync("cmux", ["close-surface", "--surface", surface], { encoding: "utf8" });

  // If the user intentionally closes the surface they are using, cmux should
  // choose the next focus normally. Only guard closure of a background surface.
  if (snapshot.focused?.surfaceRef !== surface) {
    startFocusGuard(
      snapshot.focused,
      target?.workspaceRef,
      [surface, target?.surfaceRef],
      [target?.paneRef],
      [50, 150, 350, 750, 1500, 2000, 3000, 5000],
    );
  }
}

function interpretExitSidecar(data: any): PollResult {
  if (data?.type === "error") {
    const errorMessage =
      typeof data.errorMessage === "string" && data.errorMessage.trim() !== ""
        ? data.errorMessage
        : "Subagent exited with stopReason=error (no errorMessage in sidecar).";
    return { reason: "error", exitCode: 1, errorMessage };
  }
  return { reason: "done", exitCode: 0 };
}

export async function pollForExit(
  surface: string,
  signal: AbortSignal,
  options: {
    interval: number;
    sessionFile?: string;
    sentinelFile?: string;
    onTick?: (elapsed: number) => void;
  },
): Promise<PollResult> {
  const start = Date.now();
  for (;;) {
    if (signal.aborted) throw new Error("Aborted while waiting for subagent to finish");

    if (options.sessionFile) {
      try {
        const exitFile = `${options.sessionFile}.exit`;
        if (existsSync(exitFile)) {
          const data = JSON.parse(readFileSync(exitFile, "utf8"));
          rmSync(exitFile, { force: true });
          return interpretExitSidecar(data);
        }
      } catch {}
    }

    if (options.sentinelFile && existsSync(options.sentinelFile)) {
      return { reason: "sentinel", exitCode: 0 };
    }

    try {
      const match = (await readScreenAsync(surface, 5)).match(/__SUBAGENT_DONE_(\d+)__/);
      if (match) return { reason: "sentinel", exitCode: Number.parseInt(match[1], 10) };
    } catch {
      if (options.sessionFile) {
        try {
          const exitFile = `${options.sessionFile}.exit`;
          if (existsSync(exitFile)) {
            const data = JSON.parse(readFileSync(exitFile, "utf8"));
            rmSync(exitFile, { force: true });
            return interpretExitSidecar(data);
          }
        } catch {}
      }
    }

    options.onTick?.(Math.floor((Date.now() - start) / 1000));
    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(new Error("Aborted"));
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, options.interval);
      function onAbort() {
        clearTimeout(timer);
        reject(new Error("Aborted"));
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}

export const __cmuxTest__ = {
  splitControlSequences,
  parseCreatedSurface,
  parseIdentifySnapshot,
  treeContainsPane,
  advanceFocusGuard,
};
export const __pollForExitTest__ = { interpretExitSidecar };
