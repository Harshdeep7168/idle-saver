import * as path from 'path';
import * as vscode from 'vscode';
import { MemStats, NativeBridge, ProcInfo } from './native';

type Tier = 'active' | 'light' | 'deep';

let bridge: NativeBridge;
let log: vscode.LogOutputChannel;
let status: vscode.StatusBarItem;

let tier: Tier = 'active';
let idleTimer: NodeJS.Timeout | undefined;
let lastActivity = Date.now();
let cachedTree: ProcInfo[] = [];
let treeFetchedAt = 0;
let lastFreedBytes = 0;
let runningShellExecutions = 0;

const TREE_TTL_MS = 60_000;

function cfg<T>(key: string, fallback: T): T {
  return vscode.workspace.getConfiguration('idleSaver').get<T>(key, fallback);
}

function mb(bytes: number): string {
  return `${Math.round(bytes / 1024 / 1024)} MB`;
}

// ---------------------------------------------------------------------------
// process discovery
// ---------------------------------------------------------------------------

async function getTree(force = false): Promise<ProcInfo[]> {
  const stale = Date.now() - treeFetchedAt > TREE_TTL_MS;
  if (!force && !stale && cachedTree.length) { return cachedTree; }

  const extra = cfg<string[]>('extraProcessNames', []);
  try {
    cachedTree = await bridge.tree(process.pid, extra);
    treeFetchedAt = Date.now();
  } catch (err) {
    log.error(`tree discovery failed: ${String(err)}`);
  }
  return cachedTree;
}

function targetPids(tree: ProcInfo[]): number[] {
  const excluded = new Set(cfg<number[]>('excludePids', []));
  return tree.map((p) => p.pid).filter((pid) => !excluded.has(pid));
}

// ---------------------------------------------------------------------------
// guards - never touch anything while real work is in flight
// ---------------------------------------------------------------------------

function busy(): string | undefined {
  if (vscode.debug.activeDebugSession) { return 'debug session active'; }
  if (vscode.tasks.taskExecutions.length > 0) { return 'task running'; }
  // A long `flutter build` looks exactly like idleness from the editor's point
  // of view. Without this the pty host and everything under it would get idle
  // priority halfway through the build.
  if (runningShellExecutions > 0) { return 'terminal command running'; }
  return undefined;
}

async function underPressure(pids: number[]): Promise<{ ok: boolean; stats?: MemStats }> {
  const threshold = cfg<number>('minimumFreeMemoryPercent', 25);
  if (threshold <= 0) { return { ok: true }; }
  try {
    const stats = await bridge.stats(pids);
    const freePct = (stats.freeBytes / stats.totalBytes) * 100;
    return { ok: freePct < threshold, stats };
  } catch {
    return { ok: true };
  }
}

// ---------------------------------------------------------------------------
// tier transitions
// ---------------------------------------------------------------------------

async function enterLight(): Promise<void> {
  const reason = busy();
  if (reason) { log.info(`skipping light tier: ${reason}`); return; }

  const tree = await getTree();
  const pids = targetPids(tree);
  if (!pids.length) { return; }

  const pressure = await underPressure(pids);
  if (!pressure.ok) {
    log.info('skipping trim: plenty of free memory');
    return;
  }

  const before = pressure.stats?.workingSet ?? (await bridge.stats(pids)).workingSet;
  const trimmed = await bridge.trim(pids);
  const after = (await bridge.stats(pids)).workingSet;

  lastFreedBytes = Math.max(0, before - after);
  tier = 'light';
  log.info(`light tier: trimmed ${trimmed}/${pids.length} processes, ${mb(lastFreedBytes)} released`);
  render();
}

async function enterDeep(): Promise<void> {
  const reason = busy();
  if (reason) { log.info(`skipping deep tier: ${reason}`); return; }

  const tree = await getTree(true);
  // Leave the extension host on normal priority: it is the process that has to
  // wake everything back up, and throttling it makes the return sluggish.
  const pids = targetPids(tree).filter((pid) => pid !== process.pid);
  if (!pids.length) { return; }

  await bridge.trim(targetPids(tree));

  if (cfg<boolean>('efficiencyModeOnDeepIdle', true)) {
    const count = await bridge.eco(pids);
    log.info(`deep tier: efficiency mode on ${count}/${pids.length} processes`);
  }

  const restartAfter = cfg<number>('restartLanguageServersAfterMinutes', 0);
  if (restartAfter > 0 && Date.now() - lastActivity >= restartAfter * 60_000) {
    await restartLanguageServers();
  }

  tier = 'deep';
  render();
}

/**
 * Analysis servers accumulate heap they never return. Restarting them while you
 * are away is the only way to actually give that memory back - trimming just
 * pages the garbage to disk. Off by default because it costs a re-index on
 * return.
 */
async function restartLanguageServers(): Promise<void> {
  const candidates = [
    { id: 'dart.restartAnalysisServer', label: 'Dart analysis server' },
    { id: 'typescript.restartTsServer', label: 'TypeScript server' },
  ];
  const available = new Set(await vscode.commands.getCommands(true));

  for (const c of candidates) {
    if (!available.has(c.id)) { continue; }
    try {
      await vscode.commands.executeCommand(c.id);
      log.info(`restarted ${c.label}`);
    } catch (err) {
      log.warn(`could not restart ${c.label}: ${String(err)}`);
    }
  }
  treeFetchedAt = 0; // pids changed
}

async function wake(): Promise<void> {
  if (tier === 'active') { return; }
  const previous = tier;
  tier = 'active';
  lastFreedBytes = 0;
  render();

  if (previous === 'deep') {
    const tree = await getTree();
    try {
      await bridge.restore(targetPids(tree));
      log.info('restored normal scheduling');
    } catch (err) {
      log.warn(`restore failed: ${String(err)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// idle scheduling
// ---------------------------------------------------------------------------

function idleThresholds(): { light: number; deep: number } {
  const focused = vscode.window.state.focused;
  return {
    light: (focused ? cfg<number>('lightIdleSeconds', 120) : cfg<number>('unfocusedIdleSeconds', 20)) * 1000,
    deep: cfg<number>('deepIdleSeconds', 600) * 1000,
  };
}

function schedule(): void {
  if (idleTimer) { clearTimeout(idleTimer); }
  if (!cfg<boolean>('enabled', true)) { return; }

  const { light, deep } = idleThresholds();
  const elapsed = Date.now() - lastActivity;

  let wait: number;
  if (tier === 'active') {
    wait = Math.max(1000, light - elapsed);
  } else if (tier === 'light') {
    wait = Math.max(1000, deep - elapsed);
  } else {
    wait = 60_000; // deep tier: re-trim periodically, things creep back
  }

  idleTimer = setTimeout(() => { void tick(); }, wait);
}

async function tick(): Promise<void> {
  try {
    const { light, deep } = idleThresholds();
    const elapsed = Date.now() - lastActivity;

    if (elapsed >= deep) {
      await enterDeep();
    } else if (elapsed >= light) {
      await enterLight();
    }
  } catch (err) {
    log.error(`idle tick failed: ${String(err)}`);
  } finally {
    schedule();
  }
}

function onActivity(): void {
  lastActivity = Date.now();
  if (tier !== 'active') { void wake(); }
  schedule();
}

// ---------------------------------------------------------------------------
// ui
// ---------------------------------------------------------------------------

function render(): void {
  if (!cfg<boolean>('enabled', true)) {
    status.text = '$(circle-slash) Idle Saver off';
    status.tooltip = 'Idle Saver is disabled';
    status.show();
    return;
  }

  switch (tier) {
    case 'active':
      status.text = '$(pulse) Active';
      status.tooltip = 'Idle Saver is watching. Nothing throttled.';
      break;
    case 'light':
      status.text = `$(save) Trimmed ${mb(lastFreedBytes)}`;
      status.tooltip = `Working sets evicted while idle. Freed roughly ${mb(lastFreedBytes)}.`;
      break;
    case 'deep':
      status.text = '$(leaf) Saver';
      status.tooltip = 'Deep idle: working sets trimmed, helper processes in efficiency mode.';
      break;
  }
  status.show();
}

async function showReport(): Promise<void> {
  const tree = await getTree(true);
  const sorted = [...tree].sort((a, b) => b.ws - a.ws);
  const stats = await bridge.stats(sorted.map((p) => p.pid));

  const lines = [
    `System: ${mb(stats.freeBytes)} free of ${mb(stats.totalBytes)}`,
    `VS Code tree: ${mb(stats.workingSet)} across ${sorted.length} processes`,
    `Guard: ${busy() ?? 'clear'}`,
    '',
    ...sorted.slice(0, 20).map((p) => `${mb(p.ws).padStart(8)}  ${p.name} (${p.pid})`),
  ];

  const doc = await vscode.workspace.openTextDocument({ content: lines.join('\n'), language: 'plaintext' });
  await vscode.window.showTextDocument(doc, { preview: true });
}

// ---------------------------------------------------------------------------

export function activate(context: vscode.ExtensionContext): void {
  log = vscode.window.createOutputChannel('Idle Saver', { log: true });
  const scriptPath = context.asAbsolutePath(path.join('scripts', 'memtool.ps1'));
  bridge = new NativeBridge(scriptPath, log);

  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
  status.command = 'idleSaver.showReport';

  context.subscriptions.push(log, bridge, status);

  if (process.platform !== 'win32') {
    status.text = '$(warning) Idle Saver (Windows only)';
    status.show();
    return;
  }

  const activity = [
    vscode.workspace.onDidChangeTextDocument,
    vscode.workspace.onDidSaveTextDocument,
    vscode.window.onDidChangeActiveTextEditor,
    vscode.window.onDidChangeTextEditorSelection,
    vscode.window.onDidChangeTextEditorVisibleRanges,
    vscode.window.onDidChangeActiveTerminal,
    vscode.window.onDidOpenTerminal,
    vscode.debug.onDidStartDebugSession,
    vscode.tasks.onDidStartTask,
  ];
  for (const event of activity) {
    context.subscriptions.push(event(() => onActivity()));
  }

  // Shell integration tells us when a terminal command is genuinely running, so
  // a long build is not mistaken for the user walking away.
  context.subscriptions.push(
    vscode.window.onDidStartTerminalShellExecution(() => {
      runningShellExecutions++;
      onActivity();
    }),
    vscode.window.onDidEndTerminalShellExecution(() => {
      runningShellExecutions = Math.max(0, runningShellExecutions - 1);
      onActivity();
    }),
    // A terminal closed mid-command never fires its end event, so the counter
    // would stick above zero and the extension would never idle again.
    vscode.window.onDidCloseTerminal(() => {
      runningShellExecutions = 0;
      onActivity();
    })
  );

  // Focus changes are the strongest signal we get: alt-tabbing away is a much
  // better "the user left" indicator than any keystroke timer.
  context.subscriptions.push(
    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused) { onActivity(); } else { lastActivity = Date.now(); schedule(); }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('idleSaver.trimNow', async () => {
      const tree = await getTree(true);
      const pids = targetPids(tree);
      const before = (await bridge.stats(pids)).workingSet;
      await bridge.trim(pids);
      const after = (await bridge.stats(pids)).workingSet;
      vscode.window.showInformationMessage(`Idle Saver released about ${mb(before - after)}.`);
    }),
    vscode.commands.registerCommand('idleSaver.restoreNow', () => wake()),
    vscode.commands.registerCommand('idleSaver.showReport', () => showReport()),
    vscode.commands.registerCommand('idleSaver.toggle', async () => {
      const conf = vscode.workspace.getConfiguration('idleSaver');
      const next = !conf.get<boolean>('enabled', true);
      await conf.update('enabled', next, vscode.ConfigurationTarget.Global);
      if (!next) { await wake(); }
      render();
      schedule();
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('idleSaver')) { treeFetchedAt = 0; render(); schedule(); }
    })
  );

  render();
  schedule();
  void getTree(true);
}

export function deactivate(): void {
  if (idleTimer) { clearTimeout(idleTimer); }
}