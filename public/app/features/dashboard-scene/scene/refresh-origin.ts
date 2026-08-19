import { type SceneTimeRangeState } from '@grafana/scenes';

export enum RefreshOrigin {
  Global = 'global',
  Dashboard = 'dashboard',
  Panel = 'panel',
}

let activeRefreshOrigin: RefreshOrigin | undefined;

export function runWithRefreshOrigin<T>(origin: RefreshOrigin, execute: () => T): T {
  const previousOrigin = activeRefreshOrigin;
  activeRefreshOrigin = origin;

  try {
    return execute();
  } finally {
    activeRefreshOrigin = previousOrigin;
  }
}

export function getRefreshOrigin(): RefreshOrigin | undefined {
  return activeRefreshOrigin;
}

export function getAncestorRefreshOrigin(
  nextState: SceneTimeRangeState,
  previousState: SceneTimeRangeState
): RefreshOrigin {
  if (activeRefreshOrigin !== undefined) {
    return activeRefreshOrigin;
  }

  if (
    nextState.from !== previousState.from ||
    nextState.to !== previousState.to ||
    nextState.timeZone !== previousState.timeZone
  ) {
    return RefreshOrigin.Global;
  }

  return RefreshOrigin.Dashboard;
}
