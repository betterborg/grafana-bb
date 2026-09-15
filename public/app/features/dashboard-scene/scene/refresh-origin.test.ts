import { SceneTimeRange, type SceneTimeRangeState } from '@grafana/scenes';

import { getAncestorRefreshOrigin, getRefreshOrigin, RefreshOrigin, runWithRefreshOrigin } from './refresh-origin';

describe('refresh origin', () => {
  const getState = (overrides: Partial<SceneTimeRangeState> = {}): SceneTimeRangeState => ({
    ...new SceneTimeRange().state,
    ...overrides,
  });

  it('classifies an unmarked same-range ancestor refresh as dashboard automatic', () => {
    const previousState = getState();
    const nextState = getState({ value: { ...previousState.value } });

    expect(getAncestorRefreshOrigin(nextState, previousState)).toBe(RefreshOrigin.Dashboard);
  });

  it('uses the marked origin for an ancestor refresh', () => {
    const state = getState();

    runWithRefreshOrigin(RefreshOrigin.Global, () => {
      expect(getRefreshOrigin()).toBe(RefreshOrigin.Global);
      expect(getAncestorRefreshOrigin(state, state)).toBe(RefreshOrigin.Global);
    });
  });

  it.each([
    ['from', { from: 'now-1h' }],
    ['to', { to: 'now-1m' }],
    ['time zone', { timeZone: 'America/New_York' }],
  ])('classifies an actual %s change as global', (_name, update) => {
    const previousState = getState();

    expect(getAncestorRefreshOrigin({ ...previousState, ...update }, previousState)).toBe(RefreshOrigin.Global);
  });

  it('restores nested scopes', () => {
    runWithRefreshOrigin(RefreshOrigin.Dashboard, () => {
      expect(getRefreshOrigin()).toBe(RefreshOrigin.Dashboard);

      runWithRefreshOrigin(RefreshOrigin.Panel, () => {
        expect(getRefreshOrigin()).toBe(RefreshOrigin.Panel);
      });

      expect(getRefreshOrigin()).toBe(RefreshOrigin.Dashboard);
    });

    expect(getRefreshOrigin()).toBeUndefined();
  });

  it('clears a scope when execution throws', () => {
    expect(() =>
      runWithRefreshOrigin(RefreshOrigin.Global, () => {
        throw new Error('refresh failed');
      })
    ).toThrow('refresh failed');

    expect(getRefreshOrigin()).toBeUndefined();
  });
});
