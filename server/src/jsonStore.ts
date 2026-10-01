import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export type StoredData<T extends Record<string, unknown>> = T & { seq: number };

export class JsonStore<T extends Record<string, unknown>> {
  private cache?: StoredData<T>;
  private writeQueue: Promise<StoredData<T>>;

  constructor(private readonly path: string, private readonly defaults: T) {
    this.writeQueue = this.load();
  }

  private async load(): Promise<StoredData<T>> {
    if (this.cache) return this.cache;
    try {
      const raw = await readFile(this.path, 'utf8');
      const parsed = JSON.parse(raw) as Partial<StoredData<T>>;
      this.cache = { ...this.defaults, seq: parsed.seq ?? 0, ...parsed } as StoredData<T>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.cache = { ...this.defaults, seq: 0 };
    }
    return this.cache;
  }

  async read(): Promise<StoredData<T>> {
    return this.writeQueue;
  }

  async mutate<U>(worker: (data: StoredData<T>) => U | Promise<U>): Promise<U> {
    const run = this.writeQueue.then(async () => {
      const data = await this.load();
      const result = await worker(data);
      await mkdir(dirname(this.path), { recursive: true });
      const temp = `${this.path}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
      await writeFile(temp, JSON.stringify(data), 'utf8');
      await rename(temp, this.path);
      return result;
    });
    this.writeQueue = run.then(() => this.load(), () => this.load());
    return run;
  }
}
