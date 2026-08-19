import { act, fireEvent, render, screen } from '@testing-library/react';

import { selectors } from '@grafana/e2e-selectors';
import { EmbeddedScene, SceneTimeRange, behaviors } from '@grafana/scenes';

import { DashboardRefreshPicker } from './DashboardRefreshPicker';
import { getAncestorRefreshOrigin, RefreshOrigin } from './refresh-origin';

describe('DashboardRefreshPicker', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2025-01-01T00:00:00Z'));
    setDocumentVisibility('visible');
  });

  afterEach(() => {
    jest.useRealTimers();
    setDocumentVisibility('visible');
  });

  it('marks a rendered manual refresh as global and retains the picker rendering', () => {
    const { picker, queryController, timeRange } = buildScene({
      refresh: '5s',
      intervals: ['5s', '1m'],
      withText: true,
    });
    const origins = trackOrigins(timeRange);
    const startProfile = jest.spyOn(queryController, 'startProfile');

    render(<picker.Component model={picker} />);
    expect(screen.getByTestId(selectors.components.RefreshPicker.intervalButtonV2)).toHaveTextContent('5s');
    expect(screen.getByTestId(selectors.components.RefreshPicker.runButtonV2)).toHaveTextContent('Refresh');

    fireEvent.click(screen.getByTestId(selectors.components.RefreshPicker.runButtonV2));

    expect(origins).toEqual([RefreshOrigin.Global]);
    expect(startProfile).toHaveBeenCalledWith('refresh');
  });

  it('cancels running queries without refreshing the time range', () => {
    const cancel = jest.fn();
    const queryController = new behaviors.SceneQueryController();
    const { picker, timeRange } = buildScene({}, queryController);
    const origins = trackOrigins(timeRange);
    const cancelProfile = jest.spyOn(queryController, 'cancelProfile');
    const entry = { type: 'data', origin: picker, cancel };
    queryController.queryStarted(entry);

    render(<picker.Component model={picker} />);
    fireEvent.click(screen.getByTestId(selectors.components.RefreshPicker.runButtonV2));

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancelProfile).toHaveBeenCalledTimes(1);
    expect(origins).toEqual([]);
    act(() => queryController.queryCompleted(entry));
  });

  it('classifies interval refreshes as dashboard automatic', () => {
    const { picker, queryController, timeRange } = buildScene({ refresh: '5s', intervals: ['5s'] });
    const origins = trackOrigins(timeRange);
    const startProfile = jest.spyOn(queryController, 'startProfile');
    const deactivate = picker.activate();

    jest.advanceTimersByTime(5000);

    expect(origins).toEqual([RefreshOrigin.Dashboard]);
    expect(startProfile).toHaveBeenCalledWith('refresh');
    deactivate();
  });

  it('classifies hidden-tab catch-up as dashboard automatic', () => {
    const { picker, queryController, timeRange } = buildScene({ refresh: '5s', intervals: ['5s'] });
    const origins = trackOrigins(timeRange);
    const startProfile = jest.spyOn(queryController, 'startProfile');
    const deactivate = picker.activate();

    setDocumentVisibility('hidden');
    jest.advanceTimersByTime(5000);
    expect(origins).toEqual([]);

    setDocumentVisibility('visible');
    document.dispatchEvent(new Event('visibilitychange'));

    expect(origins).toEqual([RefreshOrigin.Dashboard]);
    expect(startProfile).toHaveBeenCalledWith('refresh');
    deactivate();
  });

  it('retains SceneRefreshPicker URL state behavior', () => {
    const { picker } = buildScene({ refresh: '5s', intervals: ['5s', '1m'] });

    expect(picker.getUrlState()).toEqual({ refresh: '5s' });

    picker.updateFromUrl({ refresh: '1m' });
    expect(picker.state.refresh).toBe('1m');
    expect(picker.getUrlState()).toEqual({ refresh: '1m' });
  });
});

function buildScene(
  pickerState: ConstructorParameters<typeof DashboardRefreshPicker>[0],
  queryController = new behaviors.SceneQueryController()
) {
  const picker = new DashboardRefreshPicker(pickerState);
  const timeRange = new SceneTimeRange({ from: 'now-6h', to: 'now' });
  const scene = new EmbeddedScene({
    $timeRange: timeRange,
    $behaviors: [queryController],
    body: picker,
  });

  return { picker, queryController, scene, timeRange };
}

function trackOrigins(timeRange: SceneTimeRange): RefreshOrigin[] {
  const origins: RefreshOrigin[] = [];
  timeRange.subscribeToState((nextState, previousState) => {
    origins.push(getAncestorRefreshOrigin(nextState, previousState));
  });
  return origins;
}

function setDocumentVisibility(visibility: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: visibility });
}
