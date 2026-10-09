export interface FolderState {
  uidValidity: number;
  lastUid: number;
}

export type SyncPlan =
  | { kind: 'backfill'; reason: 'first-sync' | 'uidvalidity-changed' }
  | { kind: 'incremental'; fromUid: number };

export function readFolderState(value: unknown): FolderState | null {
  const state = value as Partial<FolderState> | null | undefined;
  return state && Number.isInteger(state.uidValidity) && Number.isInteger(state.lastUid)
    ? { uidValidity: state.uidValidity!, lastUid: state.lastUid! }
    : null;
}

// A changed UIDVALIDITY means the server renumbered the folder, so old UIDs are meaningless.
export function planSync(state: FolderState | null, uidValidity: number): SyncPlan {
  if (!state) return { kind: 'backfill', reason: 'first-sync' };
  if (state.uidValidity !== uidValidity) return { kind: 'backfill', reason: 'uidvalidity-changed' };
  return { kind: 'incremental', fromUid: state.lastUid + 1 };
}
