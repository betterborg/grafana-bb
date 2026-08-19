import { Subject } from 'rxjs';
import { waitFor } from 'test/test-utils';

import { type DataQueryRequest, type DataSourceApi, LoadingState, type PanelData } from '@grafana/data';
import {
  EmbeddedScene,
  type QueryRunnerState,
  SceneFlexLayout,
  SceneQueryRunner,
  SceneTimeRange,
} from '@grafana/scenes';

import { DashboardRefreshPicker } from './DashboardRefreshPicker';
import { DashboardSceneQueryRunner } from './DashboardSceneQueryRunner';
import { RefreshOrigin, runWithRefreshOrigin } from './refresh-origin';

const getDataSourceMock = jest.fn();
const runRequestMock = jest.fn();

jest.mock('@grafana/runtime', () => ({
  ...jest.requireActual('@grafana/runtime'),
  getDataSourceSrv: () => ({ get: getDataSourceMock }),
  getRunRequest: () => runRequestMock,
}));

describe('DashboardSceneQueryRunner', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    getDataSourceMock.mockReset();
    runRequestMock.mockReset();
  });

  it('tracks a run through datasource resolution, delayed Loading, Streaming, and Done', async () => {
    const datasource = createDatasource();
    const datasourceResolution = deferred<DataSourceApi>();
    const results = new Subject<PanelData>();
    getDataSourceMock.mockReturnValue(datasourceResolution.promise);
    runRequestMock.mockReturnValue(results);
    const runner = buildRunner();

    runWithRefreshOrigin(RefreshOrigin.Dashboard, () => runner.runQueries());

    expect(runner).toBeInstanceOf(SceneQueryRunner);
    expect(runner.isQueryPending(RefreshOrigin.Dashboard)).toBe(true);
    expect(runner.getPendingLifecycle()).toMatchObject({ id: 1, origin: RefreshOrigin.Dashboard });

    datasourceResolution.resolve(datasource);
    await datasourceResolution.promise;
    await Promise.resolve();

    expect(runRequestMock).toHaveBeenCalledTimes(1);
    expect(runner.isQueryPending()).toBe(true);

    const request = runRequestMock.mock.calls[0][1] as DataQueryRequest;
    results.next(panelData(LoadingState.Loading, request));
    expect(runner.getPendingLifecycle()?.requestId).toBe(request.requestId);

    results.next(panelData(LoadingState.Streaming, request));
    expect(runner.isQueryPending()).toBe(true);

    results.next(panelData(LoadingState.Done, request));
    expect(runner.isQueryPending()).toBe(false);
  });

  it('does not bind a newer lifecycle to an older overlapping datasource resolution', async () => {
    const firstDatasourceResolution = deferred<DataSourceApi>();
    const secondDatasourceResolution = deferred<DataSourceApi>();
    const firstResults = new Subject<PanelData>();
    const secondResults = new Subject<PanelData>();
    getDataSourceMock
      .mockReturnValueOnce(firstDatasourceResolution.promise)
      .mockReturnValueOnce(secondDatasourceResolution.promise);
    runRequestMock.mockReturnValueOnce(firstResults).mockReturnValueOnce(secondResults);
    const runner = buildRunner();

    runWithRefreshOrigin(RefreshOrigin.Dashboard, () => runner.runQueries());
    runWithRefreshOrigin(RefreshOrigin.Panel, () => runner.runQueries());

    expect(runner.getPendingLifecycle()).toMatchObject({ id: 2, origin: RefreshOrigin.Panel });
    expect(getDataSourceMock).toHaveBeenCalledTimes(1);

    firstDatasourceResolution.resolve(createDatasource());
    await firstDatasourceResolution.promise;

    await waitFor(() => expect(getDataSourceMock).toHaveBeenCalledTimes(2));
    const firstRequest = runRequestMock.mock.calls[0][1] as DataQueryRequest;
    firstResults.next(panelData(LoadingState.Done, firstRequest));
    expect(runner.getPendingLifecycle()).toMatchObject({ id: 2, origin: RefreshOrigin.Panel });

    secondDatasourceResolution.resolve(createDatasource());
    await secondDatasourceResolution.promise;
    await Promise.resolve();

    const secondRequest = runRequestMock.mock.calls[1][1] as DataQueryRequest;
    secondResults.next(panelData(LoadingState.Loading, secondRequest));
    expect(runner.getPendingLifecycle()).toMatchObject({ id: 2, requestId: secondRequest.requestId });

    secondResults.next(panelData(LoadingState.Done, secondRequest));
    expect(runner.isQueryPending()).toBe(false);
  });

  it('settles a pre-request datasource error that retains data from a prior request', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation();
    const datasourceResolution = deferred<DataSourceApi>();
    getDataSourceMock.mockReturnValue(datasourceResolution.promise);
    const previousRequest = request('previous-request');
    const runner = buildRunner({ data: panelData(LoadingState.Done, previousRequest) });

    runner.runQueries();
    expect(runner.isQueryPending()).toBe(true);

    datasourceResolution.reject(new Error('Datasource unavailable'));
    await expect(datasourceResolution.promise).rejects.toThrow('Datasource unavailable');
    await Promise.resolve();

    expect(runner.state.data).toMatchObject({
      state: LoadingState.Error,
      request: { requestId: previousRequest.requestId },
    });
    expect(runner.isQueryPending()).toBe(false);
    expect(consoleError).toHaveBeenCalledWith('PanelQueryRunner Error', expect.any(Error));
  });

  it('ignores a terminal result from the previous request and only settles the matching lifecycle', () => {
    jest.spyOn(SceneQueryRunner.prototype, 'runQueries').mockImplementation(() => {});
    const runner = new DashboardSceneQueryRunner({
      queries: [{ refId: 'A' }],
      data: panelData(LoadingState.Loading, request('old-request')),
    });

    runner.runQueries();
    runner.setState({ data: panelData(LoadingState.Done, request('old-request')) });
    expect(runner.isQueryPending()).toBe(true);

    runner.setState({ data: panelData(LoadingState.Loading, request('new-request')) });
    const lifecycle = runner.getPendingLifecycle();
    expect(lifecycle).toMatchObject({ id: 1, origin: RefreshOrigin.Global, requestId: 'new-request' });

    runner.setState({ data: panelData(LoadingState.Done, request('old-request')) });
    expect(runner.getPendingLifecycle()).toEqual(lifecycle);

    runner.setState({ data: panelData(LoadingState.Error, request('new-request')) });
    expect(runner.getPendingLifecycle()).toBeUndefined();
  });

  it('uses monotonic lifecycle ids and defaults unmarked runs to global', () => {
    jest.spyOn(SceneQueryRunner.prototype, 'runQueries').mockImplementation(() => {});
    const runner = new DashboardSceneQueryRunner({ queries: [{ refId: 'A' }] });

    runner.runQueries();
    expect(runner.getPendingLifecycle()).toMatchObject({ id: 1, origin: RefreshOrigin.Global });

    runWithRefreshOrigin(RefreshOrigin.Panel, () => runner.runQueries());
    expect(runner.getPendingLifecycle()).toMatchObject({ id: 2, origin: RefreshOrigin.Panel });
  });

  it('settles the active lifecycle when the query is cancelled', () => {
    jest.spyOn(SceneQueryRunner.prototype, 'runQueries').mockImplementation(() => {});
    const runner = new DashboardSceneQueryRunner({ queries: [{ refId: 'A' }] });

    runner.runQueries();
    runner.cancelQuery();

    expect(runner.isQueryPending()).toBe(false);
    expect(runner.state.data?.state).toBe(LoadingState.Done);
  });

  it('keeps the viewport bypass active while either owner requires it', () => {
    const bypass = jest.spyOn(SceneQueryRunner.prototype, 'bypassIsInViewChanged');
    const runner = new DashboardSceneQueryRunner({ queries: [{ refId: 'A' }] });

    runner.bypassIsInViewChanged(true);
    runner.setPanelRefreshViewportBypass(true);
    runner.bypassIsInViewChanged(false);
    runner.setPanelRefreshViewportBypass(false);

    expect(bypass.mock.calls).toEqual([[true], [true], [true], [false]]);
  });

  describe('automatic refresh origins', () => {
    beforeEach(() => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2025-01-01T00:00:00Z'));
      setDocumentVisibility('visible');
    });

    afterEach(() => {
      jest.useRealTimers();
      setDocumentVisibility('visible');
    });

    it('tracks interval refreshes as dashboard lifecycles across the deferred query callback', () => {
      const { picker, runner, timeRange } = buildAutomaticRefreshScene();
      const onRefresh = jest.spyOn(timeRange, 'onRefresh');
      const deactivate = picker.activate();

      jest.advanceTimersByTime(5000);
      jest.advanceTimersByTime(1);

      expect(onRefresh).toHaveBeenCalledTimes(1);
      expect(runner.getPendingLifecycle()).toMatchObject({ id: 2, origin: RefreshOrigin.Dashboard });
      deactivate();
    });

    it('tracks hidden-tab catch-up as a dashboard lifecycle across the deferred query callback', () => {
      const { picker, runner } = buildAutomaticRefreshScene();
      const deactivate = picker.activate();

      setDocumentVisibility('hidden');
      jest.advanceTimersByTime(5000);
      expect(runner.getPendingLifecycle()).toMatchObject({ id: 1, origin: RefreshOrigin.Global });

      setDocumentVisibility('visible');
      document.dispatchEvent(new Event('visibilitychange'));
      jest.advanceTimersByTime(1);

      expect(runner.getPendingLifecycle()).toMatchObject({ id: 2, origin: RefreshOrigin.Dashboard });
      deactivate();
    });
  });
});

function buildRunner(overrides: Partial<QueryRunnerState> = {}): DashboardSceneQueryRunner {
  const runner = new DashboardSceneQueryRunner({
    datasource: { uid: 'test-datasource' },
    queries: [{ refId: 'A' }],
    runQueriesMode: 'manual',
    ...overrides,
  });
  new EmbeddedScene({
    $timeRange: new SceneTimeRange({ from: 'now-1h', to: 'now' }),
    body: runner,
  });
  return runner;
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

function buildAutomaticRefreshScene() {
  const runner = new DashboardSceneQueryRunner({
    datasource: { uid: 'test-datasource' },
    queries: [{ refId: 'A' }],
  });
  const picker = new DashboardRefreshPicker({ refresh: '5s', intervals: ['5s'] });
  const timeRange = new SceneTimeRange({ from: 'now-1h', to: 'now' });
  new EmbeddedScene({
    $timeRange: timeRange,
    body: new SceneFlexLayout({ children: [runner, picker] }),
  });
  getDataSourceMock.mockReturnValue(new Promise<DataSourceApi>(() => {}));
  runner.runQueries();

  return { picker, runner, timeRange };
}

function request(requestId: string): DataQueryRequest {
  return {
    requestId,
    app: 'scenes',
    interval: '1s',
    intervalMs: 1000,
    range: new SceneTimeRange({ from: 'now-1h', to: 'now' }).state.value,
    scopedVars: {},
    startTime: Date.now(),
    targets: [],
    timezone: 'utc',
  };
}

function panelData(state: LoadingState, dataRequest: DataQueryRequest): PanelData {
  return {
    state,
    series: [],
    timeRange: dataRequest.range,
    request: dataRequest,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function setDocumentVisibility(visibility: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: visibility });
}
