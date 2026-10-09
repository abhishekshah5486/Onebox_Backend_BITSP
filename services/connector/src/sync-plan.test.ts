import { describe, expect, it } from 'vitest';
import { planSync, readFolderState } from './sync-plan';

describe('planSync', () => {
  it('backfills on the first sync', () => {
    expect(planSync(null, 7)).toEqual({ kind: 'backfill', reason: 'first-sync' });
  });

  it('backfills when the folder was renumbered', () => {
    expect(planSync({ uidValidity: 6, lastUid: 100 }, 7)).toEqual({
      kind: 'backfill',
      reason: 'uidvalidity-changed',
    });
  });

  it('continues after the last seen uid', () => {
    expect(planSync({ uidValidity: 7, lastUid: 100 }, 7)).toEqual({
      kind: 'incremental',
      fromUid: 101,
    });
  });
});

describe('readFolderState', () => {
  it('accepts stored state and rejects anything malformed', () => {
    expect(readFolderState({ uidValidity: 7, lastUid: 3 })).toEqual({ uidValidity: 7, lastUid: 3 });
    expect(readFolderState({ uidValidity: '7', lastUid: 3 })).toBeNull();
    expect(readFolderState(undefined)).toBeNull();
  });
});
