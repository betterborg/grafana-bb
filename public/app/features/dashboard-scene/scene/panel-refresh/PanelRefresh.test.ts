import { Subject } from 'rxjs';

import { type DataQueryRequest, type DataSourceApi, LoadingState, type PanelData } from '@grafana/data';
import { config } from '@grafana/runtime';
import { EmbeddedScene, SceneTimeRange, VizPanel } from '@grafana/scenes';

import { DashboardSceneQueryRunner } from '../DashboardSceneQueryRunner';
import { PanelTimeRange } from '../panel-timerange/PanelTimeRange';
import { RefreshOrigin, runWithRefreshOrigin } from '../refresh-origin';

import { getPanelRefreshFor, setPanelRefreshFor } from './PanelRefresh';
import { getPanelRefreshInterval, getPanelRefreshPolicy, PanelRefreshPolicy } from './policy';

const getDataSourceMock = jest.fn();
const runRequestMock = jest.fn();

jest.mock('@grafana/runtime', () => ({
  ...jest.requireActual('@grafana/runtime'),
  getDataSourceSrv: () => ({ get: getDataSourceMock }),
  getRunRequest: () => runRequestMock,
}));

describe('PanelRefresh', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    config.featureToggles.panelRefreshOverride = true;
    setDocumentVisibility('visible');
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    getDataSourceMock.mockReset();
    runRequestMock.mockReset();
    config.featureToggles.panelRefreshOverride = undefined;
  });

  it('classifies inherited, off, interval, and invalid policies', () => {
    expect(getPanelRefreshPolicy()).toBe(PanelRefreshPolicy.Inherit);
    expect(getPanelRefreshPolicy('off')).toBe(PanelRefreshPolicy.Off);
    expect(getPanelRefreshPolicy('5s')).toBe(PanelRefreshPolicy.Interval);
    expect(getPanelRefreshInterval('5s')).toBe(5000);
    expect(getPanelRefreshPolicy('invalid')).toBe(PanelRefreshPolicy.Inherit);
  });

  it('installs no timeout or viewport bypass for inherited and off policies', () => {
    const inherited = buildPanel();
    const inheritedBypass = jest.spyOn(inherited.runner, 'setPanelRefreshViewportBypass');
    const deactivateInherited = activateScheduler(inherited);

    jest.advanceTimersByTime(10_000);
    expect(inherited.runner.getPendingLifecycle()).toBeUndefined();
    expect(inheritedBypass).toHaveBeenLastCalledWith(false);
    deactivateInherited();

    const off = buildPanel('off');
    const offBypass = jest.spyOn(off.runner, 'setPanelRefreshViewportBypass');
    const deactivateOff = activateScheduler(off);

    jest.advanceTimersByTime(10_000);
    expect(off.runner.getPendingLifecycle()).toBeUndefined();
    expect(offBypass).toHaveBeenLastCalledWith(false);
    deactivateOff();
  });

  it('does not overlap a pending datasource resolution and catches up after cancellation', async () => {
    getDataSourceMock.mockReturnValue(new Promise<DataSourceApi>(() => {}));
    const scheduler = buildPanel('1s');
    const { runner } = scheduler;
    const deactivate = activateScheduler(scheduler);

    jest.advanceTimersByTime(1000);
    jest.advanceTimersByTime(1);
    expect(runner.getPendingLifecycle()).toMatchObject({ id: 1 });

    jest.advanceTimersByTime(1000);
    expect(runner.getPendingLifecycle()).toMatchObject({ id: 1 });

    runner.cancelQuery();
    await Promise.resolve();
    jest.advanceTimersByTime(1);
    expect(runner.getPendingLifecycle()).toMatchObject({ id: 2 });
    deactivate();
  });

  it('runs at most one hidden-resume catch-up', () => {
    getDataSourceMock.mockReturnValue(new Promise<DataSourceApi>(() => {}));
    const scheduler = buildPanel('1s');
    const { runner } = scheduler;
    const deactivate = activateScheduler(scheduler);

    setDocumentVisibility('hidden');
    jest.advanceTimersByTime(3000);
    expect(runner.getPendingLifecycle()).toBeUndefined();

    setDocumentVisibility('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    document.dispatchEvent(new Event('visibilitychange'));
    jest.advanceTimersByTime(0);

    expect(runner.getPendingLifecycle()).toMatchObject({ id: 1 });
    deactivate();
  });

  it('resets the private deadline when a global query is accepted', async () => {
    getDataSourceMock.mockReturnValue(new Promise<DataSourceApi>(() => {}));
    const scheduler = buildPanel('1s');
    const { runner, timeRange } = scheduler;
    const deactivate = activateScheduler(scheduler);

    jest.advanceTimersByTime(750);
    runWithRefreshOrigin(RefreshOrigin.Global, () => timeRange.onRefresh());
    jest.advanceTimersByTime(1);
    expect(runner.getPendingLifecycle()).toMatchObject({ id: 1, origin: RefreshOrigin.Global });
    runner.cancelQuery();
    await Promise.resolve();

    jest.advanceTimersByTime(998);
    expect(runner.getPendingLifecycle()).toBeUndefined();

    jest.advanceTimersByTime(2);
    jest.advanceTimersByTime(1);
    expect(runner.getPendingLifecycle()).toMatchObject({ id: 2, origin: RefreshOrigin.Panel });
    deactivate();
  });

  it('tracks only successful Done and Streaming results as fresh', () => {
    const scheduler = buildPanel('off');
    const { panel, runner } = scheduler;
    const deactivate = activateScheduler(scheduler);
    const panelRefresh = getPanelRefreshFor(panel)!;
    const request = createRequest('request-1');

    runner.setState({ data: panelData(LoadingState.Error, request) });
    expect(panelRefresh.state.lastUpdated).toBeUndefined();

    runner.setState({ data: panelData(LoadingState.Done, request) });
    expect(panelRefresh.state.lastUpdated).toBeUndefined();

    jest.setSystemTime(1000);
    runner.setState({ data: panelData(LoadingState.Done, { ...request, endTime: 1000 }) });
    expect(panelRefresh.state.lastUpdated).toBe(1000);

    jest.setSystemTime(2000);
    runner.setState({ data: panelData(LoadingState.Streaming, request) });
    expect(panelRefresh.state.lastUpdated).toBe(2000);
    deactivate();
  });

  it('disables only the panel-owned scheduler behavior behind the feature toggle', () => {
    config.featureToggles.panelRefreshOverride = false;
    const scheduler = buildPanel('1s');
    const { panel, runner, panelTimeRange } = scheduler;
    const bypass = jest.spyOn(runner, 'setPanelRefreshViewportBypass');
    const deactivate = activateScheduler(scheduler);

    jest.advanceTimersByTime(10_000);
    expect(runner.getPendingLifecycle()).toBeUndefined();
    expect(bypass).toHaveBeenLastCalledWith(false);
    expect(panelTimeRange).toBeDefined();
    expect(getPanelRefreshFor(panel)?.state.refresh).toBe('1s');
    deactivate();
  });

  it('transfers only its viewport bypass when the panel runner changes', () => {
    const scheduler = buildPanel('1s');
    const { panel, runner, timeRange } = scheduler;
    const oldBypass = jest.spyOn(runner, 'setPanelRefreshViewportBypass');
    const deactivate = activateScheduler(scheduler);
    const replacement = new DashboardSceneQueryRunner({
      queries: [{ refId: 'A' }],
      data: panelData(LoadingState.Done, createRequest('replacement', timeRange)),
    });
    const newBypass = jest.spyOn(replacement, 'setPanelRefreshViewportBypass');

    panel.setState({ $data: replacement });

    expect(oldBypass).toHaveBeenLastCalledWith(false);
    expect(newBypass).toHaveBeenLastCalledWith(true);
    deactivate();
    expect(newBypass).toHaveBeenLastCalledWith(false);
  });

  it('keeps the existing cadence while activation ownership moves between views', () => {
    getDataSourceMock.mockReturnValue(new Promise<DataSourceApi>(() => {}));
    const scheduler = buildPanel('1s');
    const { panel, panelTimeRange, runner } = scheduler;
    const deactivateTimeRange = panelTimeRange?.activate();
    const deactivateRunner = runner.activate();
    const panelRefresh = getPanelRefreshFor(panel)!;
    const releaseDashboardView = panelRefresh.activate();

    jest.advanceTimersByTime(500);
    const releaseEditView = panelRefresh.activate();
    releaseDashboardView();
    jest.advanceTimersByTime(501);

    expect(runner.getPendingLifecycle()).toMatchObject({ id: 1, origin: RefreshOrigin.Panel });
    releaseEditView();
    deactivateRunner();
    deactivateTimeRange?.();
  });

  it('keeps interval queries running outside the viewport through successive deadlines', async () => {
    const results = new Subject<PanelData>();
    getDataSourceMock.mockResolvedValue(createDatasource());
    runRequestMock.mockReturnValue(results);
    const scheduler = buildPanel('1s');
    const { runner } = scheduler;
    const deactivate = activateScheduler(scheduler);
    runner.isInViewChanged(false);

    jest.advanceTimersByTime(1001);
    await Promise.resolve();
    await Promise.resolve();
    const request = runRequestMock.mock.calls[0][1] as DataQueryRequest;
    results.next(panelData(LoadingState.Loading, request));
    results.next(panelData(LoadingState.Done, { ...request, endTime: Date.now() }));
    expect(runner.isQueryPending()).toBe(false);

    jest.advanceTimersByTime(1001);
    expect(runner.getPendingLifecycle()).toMatchObject({ id: 2, origin: RefreshOrigin.Panel });
    deactivate();
  });
});

function buildPanel(refresh?: string) {
  const timeRange = new SceneTimeRange({ from: 'now-1h', to: 'now' });
  const initialRequest = createRequest('initial', timeRange);
  const runner = new DashboardSceneQueryRunner({
    datasource: { uid: 'test-datasource' },
    queries: [{ refId: 'A' }],
    data: panelData(LoadingState.Done, initialRequest),
  });
  const panelTimeRange = refresh ? new PanelTimeRange() : undefined;
  const panel = new VizPanel({
    key: 'panel-1',
    pluginId: 'timeseries',
    title: 'Panel',
    $data: runner,
    $timeRange: panelTimeRange,
  });
  setPanelRefreshFor(panel, refresh);
  new EmbeddedScene({
    $timeRange: timeRange,
    body: panel,
  });
  return { panel, panelTimeRange, runner, timeRange };
}

function activateScheduler({ panel, panelTimeRange, runner }: ReturnType<typeof buildPanel>): () => void {
  const deactivateTimeRange = panelTimeRange?.activate();
  const deactivateRunner = runner.activate();
  const deactivateRefresh = getPanelRefreshFor(panel)!.activate();
  return () => {
    deactivateRefresh();
    deactivateRunner();
    deactivateTimeRange?.();
  };
}

function createRequest(
  requestId: string,
  timeRange = new SceneTimeRange({ from: 'now-1h', to: 'now' })
): DataQueryRequest {
  const range = timeRange.state.value;
  return {
    app: 'scenes',
    interval: '1s',
    intervalMs: 1000,
    range,
    requestId,
    scopedVars: {},
    startTime: 0,
    targets: [],
    timezone: 'utc',
  };
}

function panelData(state: LoadingState, request: DataQueryRequest): PanelData {
  return { state, request, series: [], timeRange: request.range };
}

function createDatasource(): DataSourceApi {
  return {
    uid: 'test-datasource',
    name: 'Test datasource',
    type: 'test',
    meta: { id: 'test' },
    getRef: () => ({ uid: 'test-datasource', type: 'test' }),
  } as DataSourceApi;
}

function setDocumentVisibility(visibility: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: visibility });
}
