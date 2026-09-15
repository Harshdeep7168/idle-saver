import { ChildProcess, spawn } from 'child_process';
import * as vscode from 'vscode';

export interface ProcInfo {
  pid: number;
  name: string;
  ws: number;
}

export interface MemStats {
  workingSet: number;
  freeBytes: number;
  totalBytes: number;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Keeps one PowerShell process alive for the session and talks to it in
 * newline-delimited JSON. Spawning powershell.exe per call costs 250-400ms,
 * which is unacceptable when we want to trim on every focus change.
 */
export class NativeBridge implements vscode.Disposable {
  private proc: ChildProcess | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private stdoutBuf = '';
  private disposed = false;

  constructor(
    private readonly scriptPath: string,
    private readonly log: vscode.LogOutputChannel
  ) {}

  private ensure(): ChildProcess {
    if (this.proc && this.proc.exitCode === null && !this.proc.killed) {
      return this.proc;
    }

    const proc = spawn(
      'powershell.exe',
      ['-NoProfile', '-NoLogo', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.scriptPath],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
    );

    proc.stdout?.setEncoding('utf8');
    proc.stdout?.on('data', (chunk: string) => this.onStdout(chunk));
    proc.stderr?.setEncoding('utf8');
    proc.stderr?.on('data', (chunk: string) => this.log.warn(`memtool stderr: ${chunk.trim()}`));

    proc.on('exit', (code) => {
      this.log.info(`memtool exited with code ${code}`);
      this.failAll(new Error(`helper exited (${code})`));
      this.proc = undefined;
    });
    proc.on('error', (err) => {
      this.log.error(`memtool spawn failed: ${err.message}`);
      this.failAll(err);
      this.proc = undefined;
    });

    this.proc = proc;
    return proc;
  }

  private onStdout(chunk: string): void {
    this.stdoutBuf += chunk;
    let idx: number;
    while ((idx = this.stdoutBuf.indexOf('\n')) >= 0) {
      const line = this.stdoutBuf.slice(0, idx).trim();
      this.stdoutBuf = this.stdoutBuf.slice(idx + 1);
      if (!line) { continue; }

      try {
        const reply = JSON.parse(line) as { id: number; ok: boolean; data?: unknown; error?: string };
        const waiter = this.pending.get(reply.id);
        if (!waiter) { continue; }
        this.pending.delete(reply.id);
        clearTimeout(waiter.timer);
        if (reply.ok) {
          waiter.resolve(reply.data);
        } else {
          waiter.reject(new Error(reply.error ?? 'unknown helper error'));
        }
      } catch (err) {
        this.log.warn(`unparseable helper output: ${line}`);
      }
    }
  }

  private failAll(err: Error): void {
    for (const [, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      waiter.reject(err);
    }
    this.pending.clear();
  }

  private send<T>(payload: Record<string, unknown>): Promise<T> {
    if (this.disposed) { return Promise.reject(new Error('bridge disposed')); }
    if (process.platform !== 'win32') {
      return Promise.reject(new Error('Idle Saver currently supports Windows only'));
    }

    const proc = this.ensure();
    const id = this.nextId++;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`helper timed out on ${String(payload.cmd)}`));
      }, 15_000);

      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      proc.stdin?.write(JSON.stringify({ id, ...payload }) + '\n');
    });
  }

  /** Discover the whole VS Code process tree from any pid inside it. */
  tree(rootPid: number, alsoNamed: string[]): Promise<ProcInfo[]> {
    return this.send<ProcInfo[]>({ cmd: 'tree', rootPid, alsoNamed });
  }

  /** Evict resident pages. Returns how many processes were successfully trimmed. */
  trim(pids: number[]): Promise<number> {
    return this.send<number>({ cmd: 'trim', pids });
  }

  /** EcoQoS + idle priority, i.e. Task Manager's "Efficiency mode". */
  eco(pids: number[]): Promise<number> {
    return this.send<number>({ cmd: 'eco', pids });
  }

  /** Hand scheduling control back to the system and restore normal priority. */
  restore(pids: number[]): Promise<number> {
    return this.send<number>({ cmd: 'restore', pids });
  }

  stats(pids: number[]): Promise<MemStats> {
    return this.send<MemStats>({ cmd: 'stats', pids });
  }

  dispose(): void {
    this.disposed = true;
    this.failAll(new Error('bridge disposed'));
    this.proc?.stdin?.end();
    this.proc?.kill();
    this.proc = undefined;
  }
}
