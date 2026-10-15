// Durable runner state: task → harness session mappings and the job ledger.
// A single JSON file is plenty for a personal deployment. Writes are
// serialized and atomic (write temp file, then rename) with 0600 permissions.

import type { HarnessBackend, TurnHandle } from "./adapters/types.ts";

export type JobState =
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out";

export interface JobRecord {
  jobId: string;
  backend: HarnessBackend;
  todoistUserId: string;
  taskId: string;
  sessionKey: string;
  state: JobState;
  handle?: TurnHandle;
  result?: JobResult;
  callbackDelivered: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface JobResult {
  status: Exclude<JobState, "running">;
  output?: string;
  error_code?: string;
  denied_approvals: number;
}

export interface SessionRecord {
  sessionId: string;
  updatedAt: number;
}

interface StateFile {
  version: 1;
  sessions: Record<string, SessionRecord>;
  jobs: Record<string, JobRecord>;
}

export interface RunnerStore {
  getSession(sessionKey: string): SessionRecord | undefined;
  setSession(sessionKey: string, sessionId: string): Promise<void>;
  getJob(jobId: string): JobRecord | undefined;
  listJobs(): JobRecord[];
  putJob(job: JobRecord): Promise<void>;
}

const JOB_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export class MemoryStore implements RunnerStore {
  protected state: StateFile = { version: 1, sessions: {}, jobs: {} };

  getSession(key: string) {
    return this.state.sessions[key];
  }
  async setSession(key: string, sessionId: string) {
    this.state.sessions[key] = { sessionId, updatedAt: Date.now() };
    await this.persist();
  }
  getJob(jobId: string) {
    return this.state.jobs[jobId];
  }
  listJobs() {
    return Object.values(this.state.jobs);
  }
  async putJob(job: JobRecord) {
    this.state.jobs[job.jobId] = { ...job, updatedAt: Date.now() };
    await this.persist();
  }
  protected async persist(): Promise<void> {}
}

export class FileStore extends MemoryStore {
  private writeChain: Promise<void> = Promise.resolve();

  private constructor(private readonly path: string) {
    super();
  }

  static async open(path: string): Promise<FileStore> {
    const store = new FileStore(path);
    try {
      const parsed = JSON.parse(await Deno.readTextFile(path));
      if (parsed?.version === 1) {
        store.state = { version: 1, sessions: parsed.sessions ?? {}, jobs: parsed.jobs ?? {} };
      }
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
    }
    const dir = path.replace(/\/[^/]*$/, "");
    if (dir && dir !== path) await Deno.mkdir(dir, { recursive: true, mode: 0o700 });
    return store;
  }

  protected override persist(): Promise<void> {
    const cutoff = Date.now() - JOB_RETENTION_MS;
    for (const [id, job] of Object.entries(this.state.jobs)) {
      if (job.state !== "running" && job.callbackDelivered && job.updatedAt < cutoff) {
        delete this.state.jobs[id];
      }
    }
    const snapshot = JSON.stringify(this.state);
    this.writeChain = this.writeChain.catch(() => {}).then(async () => {
      const tmp = `${this.path}.tmp`;
      await Deno.writeTextFile(tmp, snapshot, { mode: 0o600 });
      await Deno.rename(tmp, this.path);
    });
    return this.writeChain;
  }
}
