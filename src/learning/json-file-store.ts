import { randomBytes } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { PiiShieldError } from '../errors.js';
import type { CustomEntityType } from './custom-entity-type.js';
import { type CustomEntityStore, sortByName, typesFromJSON } from './store.js';

export interface JsonFileCustomEntityStoreOptions {
  /**
   * Lock writes across processes with a lock file next to the store (`<path>.lock`, created exclusively).
   * Default true. A lock older than `staleMs` (default 10000) is taken over; waiting longer than
   * `timeoutMs` (default 5000) throws.
   */
  lock?: boolean | { staleMs?: number; timeoutMs?: number };
}

/**
 * Learned types in one JSON file: readable, diffable, easy to review before deploying.
 *
 * The file is byte-identical to PHP's JsonFileCustomEntityStore (sorted by name, pretty-printed with
 * four spaces, unescaped Unicode and slashes, trailing newline), so both can read each other's file.
 * Writes are atomic (temporary file in the same directory + rename); the file gets mode 0600, a missing
 * directory 0700. save() and remove() read, change and write the whole list under a lock file, which
 * also serialises writers within one process. PHP's LockingCustomEntityStore uses symfony/lock instead:
 * the two locks do not see each other.
 */
export class JsonFileCustomEntityStore implements CustomEntityStore {
  readonly #path: string;
  readonly #lock: { staleMs: number; timeoutMs: number } | null;

  constructor(path: string, options: JsonFileCustomEntityStoreOptions = {}) {
    this.#path = path;
    const { lock = true } = options;
    this.#lock =
      lock === false
        ? null
        : {
            staleMs: (lock === true ? undefined : lock.staleMs) ?? 10_000,
            timeoutMs: (lock === true ? undefined : lock.timeoutMs) ?? 5_000,
          };
  }

  async all(): Promise<CustomEntityType[]> {
    let raw: string;
    try {
      raw = await readFile(this.#path, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT' || (e as NodeJS.ErrnoException).code === 'EISDIR') {
        return [];
      }
      throw e;
    }
    let data: unknown = null;
    try {
      data = JSON.parse(raw);
    } catch {
      // handled below, like PHP's json_decode() returning null
    }
    if (typeof data !== 'object' || data === null) {
      throw new PiiShieldError(`"${this.#path}" does not contain a list of learned types.`, 'LEARNING_STORE_CORRUPT');
    }

    return typesFromJSON(data);
  }

  async get(name: string): Promise<CustomEntityType | null> {
    return (await this.all()).find((t) => t.name === name) ?? null;
  }

  save(type: CustomEntityType): Promise<void> {
    return this.#locked(async () => {
      const types = (await this.all()).filter((t) => t.name !== type.name);
      await this.#write([...types, type]);
    });
  }

  remove(name: string): Promise<void> {
    return this.#locked(async () => {
      await this.#write((await this.all()).filter((t) => t.name !== name));
    });
  }

  async #write(types: CustomEntityType[]): Promise<void> {
    const json = `${encodeJson(sortByName(types))}\n`;
    const dir = dirname(this.#path);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = join(dir, `.learned-${randomBytes(6).toString('hex')}`);
    const file = await open(tmp, 'wx', 0o600);
    try {
      await file.writeFile(json, 'utf8');
    } finally {
      await file.close();
    }
    try {
      await chmod(tmp, 0o600);
      await rename(tmp, this.#path);
    } catch (e) {
      await unlink(tmp).catch(() => undefined);
      throw e;
    }
  }

  async #locked(write: () => Promise<void>): Promise<void> {
    if (this.#lock === null) {
      return write();
    }
    const lockPath = `${this.#path}.lock`;
    await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
    const deadline = Date.now() + this.#lock.timeoutMs;
    for (let wait = 5; ; wait = Math.min(wait * 2, 25)) {
      try {
        const handle = await open(lockPath, 'wx', 0o600);
        await handle.writeFile(`${String(process.pid)}\n`);
        await handle.close();
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw e;
        }
      }
      const age = await stat(lockPath).then(
        (s) => Date.now() - s.mtimeMs,
        () => 0,
      );
      if (age > this.#lock.staleMs) {
        await unlink(lockPath).catch(() => undefined); // a crashed writer's lock
        continue;
      }
      if (Date.now() > deadline) {
        throw new PiiShieldError(`Timed out waiting for the lock "${lockPath}".`, 'LEARNING_STORE_LOCKED');
      }
      await sleep(wait);
    }
    try {
      await write();
    } finally {
      await unlink(lockPath).catch(() => undefined);
    }
  }
}

/**
 * PHP's json_encode() with JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES:
 * like JSON.stringify(…, null, 4), except that PHP still escapes U+2028 and U+2029.
 */
export function encodeJson(value: unknown): string {
  return JSON.stringify(value, null, 4).replace(
    /[\u{2028}\u{2029}]/gu,
    (c) => `\\u${(c.codePointAt(0) ?? 0).toString(16)}`,
  );
}
