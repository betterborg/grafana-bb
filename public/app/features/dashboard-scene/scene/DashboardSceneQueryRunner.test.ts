import { Subject } from 'rxjs';

import { type DataQueryRequest, type DataSourceApi, LoadingState, type PanelData } from '@grafana/data';
import { EmbeddedScene, SceneQueryRunner, SceneTimeRange } from '@grafana/scenes';

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
});

function buildRunner(): DashboardSceneQueryRunner {
  const runner = new DashboardSceneQueryRunner({
    datasource: { uid: 'test-datasource' },
    queries: [{ refId: 'A' }],
    runQueriesMode: 'manual',
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
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
