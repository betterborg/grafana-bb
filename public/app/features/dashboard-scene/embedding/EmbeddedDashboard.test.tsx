import { act, render, waitFor } from 'test/test-utils';

import { dateTime, type TimeRange } from '@grafana/data';
import { SceneGridLayout, SceneTimeRange, behaviors, sceneGraph } from '@grafana/scenes';

import { DashboardControls } from '../scene/DashboardControls';
import { DashboardScene } from '../scene/DashboardScene';
import { DefaultGridLayoutManager } from '../scene/layout-default/DefaultGridLayoutManager';
import { getAncestorRefreshOrigin, RefreshOrigin } from '../scene/refresh-origin';
import { mockResizeObserver } from '../utils/test-utils';

import { EmbeddedDashboard } from './EmbeddedDashboard';

const mockStateManager = {
  useState: jest.fn(),
  loadDashboard: jest.fn(),
  clearState: jest.fn(),
};

jest.mock('../pages/DashboardScenePageStateManager', () => ({
  getDashboardScenePageStateManager: () => mockStateManager,
}));

jest.mock('../utils/utils', () => ({
  ...jest.requireActual('../utils/utils'),
  useScenesFlickeringFix: jest.fn(),
}));

function buildScene(queryController = new behaviors.SceneQueryController()) {
  return new DashboardScene({
    title: 'embedded',
    uid: 'embedded-1',
    meta: {},
    $timeRange: new SceneTimeRange({ from: 'now-6h', to: 'now' }),
    $behaviors: [queryController],
    controls: new DashboardControls({}),
    body: new DefaultGridLayoutManager({ grid: new SceneGridLayout({ children: [] }) }),
  });
}

function makeTimeRange(from: string, to: string): TimeRange {
  return { from: dateTime(), to: dateTime(), raw: { from, to } };
}

describe('EmbeddedDashboard', () => {
  beforeAll(() => {
    mockResizeObserver();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('controlled timeRange', () => {
    it('syncs the time range into the embedded dashboard', async () => {
      const model = buildScene();
      mockStateManager.useState.mockReturnValue({ dashboard: model });
      const onTimeRangeChange = jest.spyOn(sceneGraph.getTimeRange(model), 'onTimeRangeChange');

      render(<EmbeddedDashboard uid="embedded-1" timeRange={makeTimeRange('now-1h', 'now')} />);

      await waitFor(() => expect(onTimeRangeChange).toHaveBeenCalledTimes(1));
      expect(sceneGraph.getTimeRange(model).state.from).toBe('now-1h');
      expect(sceneGraph.getTimeRange(model).state.to).toBe('now');
    });

    it('updates the time range when the prop changes', async () => {
      const model = buildScene();
      mockStateManager.useState.mockReturnValue({ dashboard: model });

      const { rerender } = render(<EmbeddedDashboard uid="embedded-1" timeRange={makeTimeRange('now-1h', 'now')} />);
      await waitFor(() => expect(sceneGraph.getTimeRange(model).state.from).toBe('now-1h'));

      rerender(<EmbeddedDashboard uid="embedded-1" timeRange={makeTimeRange('now-15m', 'now')} />);
      await waitFor(() => expect(sceneGraph.getTimeRange(model).state.from).toBe('now-15m'));
    });
  });

  describe('controlled refreshToken', () => {
    it('refreshes globally without cancelling when the token changes while queries are running', async () => {
      const queryController = new behaviors.SceneQueryController();
      const model = buildScene(queryController);
      mockStateManager.useState.mockReturnValue({ dashboard: model });
      const timeRange = sceneGraph.getTimeRange(model);
      const onRefresh = jest.spyOn(timeRange, 'onRefresh');
      const pickerRefresh = jest.spyOn(model.state.controls!.state.refreshPicker, 'onRefresh');
      const cancelAll = jest.spyOn(queryController, 'cancelAll');
      const cancelProfile = jest.spyOn(queryController, 'cancelProfile');
      const origins: RefreshOrigin[] = [];
      timeRange.subscribeToState((nextState, previousState) => {
        origins.push(getAncestorRefreshOrigin(nextState, previousState));
      });

      const { rerender } = render(<EmbeddedDashboard uid="embedded-1" refreshToken={0} />);
      // Initial token value must not trigger a refresh (would double-run queries on mount).
      await waitFor(() => expect(onRefresh).not.toHaveBeenCalled());

      const cancelQuery = jest.fn();
      const runningQuery = { type: 'data', origin: model, cancel: cancelQuery };
      act(() => queryController.queryStarted(runningQuery));
      rerender(<EmbeddedDashboard uid="embedded-1" refreshToken={1} />);
      await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
      expect(origins).toEqual([RefreshOrigin.Global]);
      expect(pickerRefresh).not.toHaveBeenCalled();
      expect(cancelAll).not.toHaveBeenCalled();
      expect(cancelProfile).not.toHaveBeenCalled();
      expect(cancelQuery).not.toHaveBeenCalled();

      // Re-rendering with the same token does not refresh again.
      rerender(<EmbeddedDashboard uid="embedded-1" refreshToken={1} />);
      expect(onRefresh).toHaveBeenCalledTimes(1);
      act(() => queryController.queryCompleted(runningQuery));
    });
  });
});
