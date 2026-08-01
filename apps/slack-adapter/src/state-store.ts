import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Firestore } from "@google-cloud/firestore";

export interface StateStore {
  get<T>(namespace: string, key: string): Promise<T | null>;
  list<T>(namespace: string): Promise<T[]>;
  set<T>(namespace: string, key: string, value: T): Promise<void>;
  create<T>(namespace: string, key: string, value: T): Promise<boolean>;
  compareAndSet<T extends RevisionedState>(
    namespace: string,
    key: string,
    expectedRevision: number,
    value: T,
  ): Promise<boolean>;
  remove(namespace: string, key: string): Promise<void>;
  append<T>(namespace: string, value: T): Promise<string>;
}

export interface RevisionedState {
  revision: number;
}

interface StoredValue<T> {
  schemaVersion: 1;
  updatedAt: string;
  value: T;
}

export class LocalStateStore implements StateStore {
  private readonly rootDirectory: string;
  private readonly locks = new Map<string, Promise<void>>();

  constructor(rootDirectory: string) {
    this.rootDirectory = rootDirectory;
  }

  async get<T>(namespace: string, key: string): Promise<T | null> {
    try {
      const stored = JSON.parse(
        await readFile(this.path(namespace, key), "utf8"),
      ) as StoredValue<T>;
      return stored.value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  async set<T>(namespace: string, key: string, value: T): Promise<void> {
    await writeAtomic(this.path(namespace, key), serialize(value));
  }

  async list<T>(namespace: string): Promise<T[]> {
    const directory = join(this.rootDirectory, safeSegment(namespace));
    let files: string[];
    try {
      files = await readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
    return Promise.all(
      files
        .filter((file) => file.endsWith(".json"))
        .map(async (file) => {
          const stored = JSON.parse(
            await readFile(join(directory, file), "utf8"),
          ) as StoredValue<T>;
          return stored.value;
        }),
    );
  }

  async create<T>(namespace: string, key: string, value: T): Promise<boolean> {
    const path = this.path(namespace, key);
    await mkdir(dirname(path), { recursive: true });
    try {
      await writeFile(path, serialize(value), { encoding: "utf8", flag: "wx", mode: 0o600 });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        return false;
      }
      throw error;
    }
  }

  async compareAndSet<T extends RevisionedState>(
    namespace: string,
    key: string,
    expectedRevision: number,
    value: T,
  ): Promise<boolean> {
    const path = this.path(namespace, key);
    return this.withLock(path, async () => {
      const current = await this.get<RevisionedState>(namespace, key);
      if (!current || current.revision !== expectedRevision) {
        return false;
      }
      await writeAtomic(path, serialize(value));
      return true;
    });
  }

  async remove(namespace: string, key: string): Promise<void> {
    try {
      await unlink(this.path(namespace, key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  async append<T>(namespace: string, value: T): Promise<string> {
    const key = randomUUID();
    await this.set(namespace, key, value);
    return key;
  }

  private path(namespace: string, key: string): string {
    return join(this.rootDirectory, safeSegment(namespace), `${safeSegment(key)}.json`);
  }

  private async withLock<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => gate);
    this.locks.set(key, queued);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (this.locks.get(key) === queued) {
        this.locks.delete(key);
      }
    }
  }
}

export class FirestoreStateStore implements StateStore {
  private readonly firestore: Firestore;
  private readonly prefix: string;

  constructor(firestore = new Firestore(), prefix = "arttra") {
    if (!/^[a-z][a-z0-9_]{0,30}$/.test(prefix)) {
      throw new Error("Firestore collection prefixが不正です。");
    }
    this.firestore = firestore;
    this.prefix = prefix;
  }

  async get<T>(namespace: string, key: string): Promise<T | null> {
    const snapshot = await this.document(namespace, key).get();
    if (!snapshot.exists) {
      return null;
    }
    return (snapshot.data() as StoredValue<T>).value;
  }

  async set<T>(namespace: string, key: string, value: T): Promise<void> {
    await this.document(namespace, key).set(envelope(value));
  }

  async list<T>(namespace: string): Promise<T[]> {
    const snapshot = await this.collection(namespace).get();
    return snapshot.docs.map((document) => (document.data() as StoredValue<T>).value);
  }

  async create<T>(namespace: string, key: string, value: T): Promise<boolean> {
    try {
      await this.document(namespace, key).create(envelope(value));
      return true;
    } catch (error) {
      const code = firestoreErrorCode(error);
      if (code === 6 || code === "already-exists") {
        return false;
      }
      throw error;
    }
  }

  async compareAndSet<T extends RevisionedState>(
    namespace: string,
    key: string,
    expectedRevision: number,
    value: T,
  ): Promise<boolean> {
    return this.firestore.runTransaction(async (transaction) => {
      const reference = this.document(namespace, key);
      const snapshot = await transaction.get(reference);
      if (!snapshot.exists) {
        return false;
      }
      const current = (snapshot.data() as StoredValue<RevisionedState>).value;
      if (current.revision !== expectedRevision) {
        return false;
      }
      transaction.set(reference, envelope(value));
      return true;
    });
  }

  async remove(namespace: string, key: string): Promise<void> {
    await this.document(namespace, key).delete();
  }

  async append<T>(namespace: string, value: T): Promise<string> {
    const reference = await this.collection(namespace).add(envelope(value));
    return reference.id;
  }

  private collection(namespace: string) {
    return this.firestore.collection(`${this.prefix}_${safeNamespace(namespace)}`);
  }

  private document(namespace: string, key: string) {
    return this.collection(namespace).doc(safeSegment(key));
  }
}

function serialize<T>(value: T): string {
  return `${JSON.stringify(envelope(value), null, 2)}\n`;
}

function envelope<T>(value: T): StoredValue<T> {
  return { schemaVersion: 1, updatedAt: new Date().toISOString(), value };
}

function safeNamespace(value: string): string {
  if (!/^[a-z][a-z0-9_-]{0,60}$/.test(value)) {
    throw new Error(`state namespaceが不正です: ${value}`);
  }
  return value.replaceAll("-", "_");
}

function safeSegment(value: string): string {
  if (value.length === 0 || value.length > 256) {
    throw new Error("state keyが不正です。");
  }
  return Buffer.from(value).toString("base64url");
}

async function writeAtomic(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, value, { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, path);
}

function firestoreErrorCode(error: unknown): string | number | undefined {
  return error && typeof error === "object" && "code" in error
    ? (error.code as string | number)
    : undefined;
}
