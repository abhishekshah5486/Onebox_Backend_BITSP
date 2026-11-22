// What OneBox keeps per email: its id, embedding and a JSON payload it filters on itself.
export interface Point {
  id: string;
  vector: number[];
  payload: Record<string, unknown>;
}

export interface StoredPoint {
  id: string;
  vector: number[] | null;
  payload: Record<string, unknown>;
}

// A nearest match; score is cosine similarity, higher is closer.
export interface Hit {
  id: string;
  score: number;
  payload: Record<string, unknown>;
}

// One collection (index, table or class, depending on the database) of a given size. Every
// call names the user, so stores that keep users apart (namespaces) can.
export interface Collection {
  name: string;
  ensure(): Promise<void>;
  get(userId: string, ids: string[], withVectors: boolean): Promise<StoredPoint[]>;
  upsert(userId: string, points: Point[]): Promise<void>;
  delete(userId: string, ids: string[]): Promise<void>;
  deleteUser(userId: string): Promise<void>;
  query(userId: string, vector: number[], limit: number): Promise<Hit[]>;
}

export interface VectorStore {
  collection(name: string, dimensions: number): Collection;
  // The collections in the store, by the names collection() takes.
  collections(): Promise<string[]>;
  // An authenticated call, so wrong keys fail here; throws StoreCheckError.
  check(): Promise<void>;
  close(): Promise<void>;
}

// Why a store can't be used, in words for the person who set it up.
export class StoreCheckError extends Error {
  override name = 'StoreCheckError';
}

// Turns a collection name into one the database accepts. Applying it twice changes nothing, so
// names read back from the store map to themselves.
export function cleanName(
  name: string,
  { allowed, replace = '_', max = 63 }: { allowed: RegExp; replace?: string; max?: number },
) {
  return name.replace(allowed, replace).slice(0, max);
}

export const parsePayload = (raw: unknown): Record<string, unknown> =>
  typeof raw === 'string'
    ? (JSON.parse(raw) as Record<string, unknown>)
    : ((raw ?? {}) as Record<string, unknown>);

// Several databases score cosine as (1 + cos) / 2; this maps it back to cos.
export const fromHalfCosine = (score: number) => score * 2 - 1;
