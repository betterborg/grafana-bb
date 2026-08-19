import { act, fireEvent, render, screen } from '@testing-library/react';
import { Subject } from 'rxjs';
import { getWrapper } from 'test/test-utils';

import { type DataQueryRequest, type DataSourceApi, dateTimeFormat, LoadingState, type PanelData } from '@grafana/data';
import { getPanelPlugin } from '@grafana/data/test';
import { config, setPluginImportUtils } from '@grafana/runtime';
import { EmbeddedScene, LazyLoader, SceneTimeRange, SceneVariableSet, TestVariable, VizPanel } from '@grafana/scenes';

import { PanelEditPanelWrapper } from '../../panel-edit/PanelEditPanelWrapper';
import { SoloPanelContextProvider, SoloPanelContextWithPathIdFilter } from '../../solo/SoloPanelContext';
import { activateFullSceneTree } from '../../utils/test-utils';
import { DashboardScene } from '../DashboardScene';
import { DashboardSceneQueryRunner } from '../DashboardSceneQueryRunner';
import { DefaultGridLayoutManager } from '../layout-default/DefaultGridLayoutManager';
import { PanelTimeRange } from '../panel-timerange/PanelTimeRange';
import { RefreshOrigin, runWithRefreshOrigin } from '../refresh-origin';

import { getPanelRefreshFor, setPanelRefreshFor } from './PanelRefresh';
import { getPanelRefreshInterval, getPanelRefreshPolicy, PanelRefreshPolicy } from './policy';

const getDataSourceMock = jest.fn();
const runRequestMock = jest.fn();
const panelPlugin = getPanelPlugin({ id: 'timeseries' }, () => null);

setPluginImportUtils({
  importPanelPlugin: () => Promise.resolve(panelPlugin),
  getPanelPluginFromCache: () => panelPlugin,
});

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

  it.each([
    ['an interval', '30s', '30s'],
    ['off', 'off', 'Off'],
  ])('renders an always-visible localized indicator for %s policy', (_description, refresh, badge) => {
    const { panel } = buildPanel(refresh, { title: '' });
    const panelRefresh = getPanelRefreshFor(panel)!;
    const Providers = getWrapper({});

    expect(panel.state.hoverHeader).toBe(false);
    expect(panel.state.titleItems).toContain(panelRefresh);

    render(
      <Providers>
        <panel.Component model={panel} />
      </Providers>
    );

    expect(screen.getByText(badge)).toBeInTheDocument();
  });

  it('shows policy and the latest streaming freshness in the tooltip', () => {
    const { panel, runner } = buildPanel('30s', { title: '' });
    const panelRefresh = getPanelRefreshFor(panel)!;
    const Providers = getWrapper({});
    const deactivate = panel.activate();
    jest.setSystemTime(2000);

    runner.setState({ data: panelData(LoadingState.Streaming, createRequest('streaming')) });
    render(
      <Providers>
        <panelRefresh.Component model={panelRefresh} />
      </Providers>
    );
    fireEvent.mouseEnter(screen.getByText('30s'));
    act(() => jest.advanceTimersByTime(1000));

    expect(screen.getByText('Panel refreshes every 30s')).toBeInTheDocument();
    expect(screen.getByText(`Updated ${dateTimeFormat(2000, { timeZone: 'browser' })}`)).toBeInTheDocument();
    deactivate();
  });

  it('restores hover-only chrome for inherited and feature-disabled policies without reconciliation loops', () => {
    const inherited = buildPanel(undefined, { title: '' }).panel;
    const inheritedRefresh = getPanelRefreshFor(inherited)!;
    expect(inherited.state.hoverHeader).toBe(true);
    expect(inherited.state.titleItems ?? []).not.toContain(inheritedRefresh);

    const explicit = buildPanel('off', { title: '' }).panel;
    const setState = jest.spyOn(explicit, 'setState');
    setPanelRefreshFor(explicit, undefined);
    const callsAfterRestore = setState.mock.calls.length;
    setPanelRefreshFor(explicit, undefined);
    expect(explicit.state.hoverHeader).toBe(true);
    expect(explicit.state.titleItems ?? []).not.toContain(getPanelRefreshFor(explicit));
    expect(setState).toHaveBeenCalledTimes(callsAfterRestore);

    config.featureToggles.panelRefreshOverride = false;
    const disabled = buildPanel('30s', { title: '' }).panel;
    expect(disabled.state.hoverHeader).toBe(true);
    expect(disabled.state.titleItems ?? []).not.toContain(getPanelRefreshFor(disabled));
  });

  it('keeps the indicator visible when the real dashboard title handler clears the panel title', () => {
    const { dashboard, panel } = buildDashboardPanel('off');

    dashboard.updatePanelTitle(panel, '');
    expect(panel.state.hoverHeader).toBe(false);

    setPanelRefreshFor(panel, undefined);
    expect(panel.state.hoverHeader).toBe(true);
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

  it('installs interception when a default panel transitions between inherit, interval, and off', () => {
    getDataSourceMock.mockReturnValue(new Promise<DataSourceApi>(() => {}));
    const scheduler = buildPanel();
    const { panel, runner, timeRange } = scheduler;
    const deactivate = activateScheduler(scheduler);

    expect(panel.state.$timeRange).toBeUndefined();

    setPanelRefreshFor(panel, 'off');
    expect(panel.state.$timeRange).toBeInstanceOf(PanelTimeRange);
    timeRange.onRefresh();
    jest.advanceTimersByTime(1);
    expect(runner.getPendingLifecycle()).toBeUndefined();

    setPanelRefreshFor(panel, '1s');
    jest.advanceTimersByTime(1000);
    jest.advanceTimersByTime(1);
    expect(runner.getPendingLifecycle()).toMatchObject({ id: 1, origin: RefreshOrigin.Panel });
    runner.cancelQuery();

    setPanelRefreshFor(panel, 'off');
    jest.advanceTimersByTime(10_000);
    timeRange.onRefresh();
    jest.advanceTimersByTime(1);
    expect(runner.getPendingLifecycle()).toBeUndefined();

    setPanelRefreshFor(panel, undefined);
    timeRange.onRefresh();
    jest.advanceTimersByTime(1);
    expect(runner.getPendingLifecycle()).toMatchObject({ id: 2, origin: RefreshOrigin.Dashboard });
    deactivate();
  });

  it('does not overlap datasource resolution or the delayed pre-Loading window', async () => {
    const datasourceResolution = deferred<DataSourceApi>();
    const results = new Subject<PanelData>();
    getDataSourceMock.mockReturnValue(datasourceResolution.promise);
    runRequestMock.mockReturnValue(results);
    const scheduler = buildPanel('100ms');
    const { runner } = scheduler;
    const deactivate = activateScheduler(scheduler);

    jest.advanceTimersByTime(101);
    expect(runner.getPendingLifecycle()).toMatchObject({ id: 1 });
    expect(getDataSourceMock).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(200);
    expect(runner.getPendingLifecycle()).toMatchObject({ id: 1 });
    expect(getDataSourceMock).toHaveBeenCalledTimes(1);
    expect(runRequestMock).not.toHaveBeenCalled();

    datasourceResolution.resolve(createDatasource());
    await datasourceResolution.promise;
    await Promise.resolve();
    expect(runRequestMock).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(200);
    expect(getDataSourceMock).toHaveBeenCalledTimes(1);
    expect(runner.getPendingLifecycle()).toMatchObject({ id: 1, requestId: expect.any(String) });

    const request = runRequestMock.mock.calls[0][1] as DataQueryRequest;
    results.next(panelData(LoadingState.Loading, request));
    jest.advanceTimersByTime(200);
    expect(getDataSourceMock).toHaveBeenCalledTimes(1);

    results.next(panelData(LoadingState.Done, { ...request, endTime: Date.now() }));
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

  it('resets the private deadline when a variable-driven panel range is accepted', () => {
    const windowVariable = new TestVariable({
      name: 'window',
      value: '10m',
      text: '10m',
      query: '',
      updateOptions: false,
    });
    const scheduler = buildPanel('1s', {
      panelTimeRange: new PanelTimeRange({ timeFrom: '$window' }),
      variables: new SceneVariableSet({ variables: [windowVariable] }),
    });
    const { runner, scene } = scheduler;
    getDataSourceMock.mockReturnValue(new Promise<DataSourceApi>(() => {}));
    const deactivate = activateFullSceneTree(scene);
    expect(runner.getPendingLifecycle()).toMatchObject({ id: 1, origin: RefreshOrigin.Global });
    runner.cancelQuery();

    jest.advanceTimersByTime(750);
    windowVariable.changeValueTo('15m', '15m');
    jest.advanceTimersByTime(1);
    expect(runner.getPendingLifecycle()).toMatchObject({ id: 2, origin: RefreshOrigin.Global });
    runner.cancelQuery();

    jest.advanceTimersByTime(249);
    jest.advanceTimersByTime(1);
    expect(runner.getPendingLifecycle()).toBeUndefined();

    jest.advanceTimersByTime(1000);
    jest.advanceTimersByTime(1);
    expect(runner.getPendingLifecycle()).toMatchObject({ id: 3, origin: RefreshOrigin.Panel });
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
    expect(panelTimeRange).toBeUndefined();
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

  it.each([
    { refresh: '1s', expectedRuns: 1 },
    { refresh: 'off', expectedRuns: 0 },
  ])(
    'keeps $refresh policy and cadence through real normal, solo, and panel-edit views',
    ({ refresh, expectedRuns }) => {
      getDataSourceMock.mockReturnValue(new Promise<DataSourceApi>(() => {}));
      const { dashboard, panel, runner } = buildDashboardPanel(refresh);
      const Providers = getWrapper({});
      const soloContext = new SoloPanelContextWithPathIdFilter('1');
      const normalView = render(
        <Providers>
          <panel.Component model={panel} />
        </Providers>
      );
      expect(getPanelRefreshFor(panel)?.isActive).toBe(true);

      act(() => jest.advanceTimersByTime(400));
      const soloView = render(
        <Providers>
          <SoloPanelContextProvider value={soloContext} singleMatch dashboard={dashboard}>
            {renderDashboardBody(dashboard)}
          </SoloPanelContextProvider>
        </Providers>
      );
      expect(getPanelRefreshFor(panel)?.isActive).toBe(true);
      normalView.unmount();
      act(() => jest.advanceTimersByTime(300));
      const editView = render(
        <Providers>
          <PanelEditPanelWrapper panel={panel} dashboard={dashboard} />
        </Providers>
      );
      expect(getPanelRefreshFor(panel)?.isActive).toBe(true);
      soloView.unmount();
      act(() => jest.advanceTimersByTime(200));
      const returnedView = render(
        <Providers>
          <panel.Component model={panel} />
        </Providers>
      );
      expect(getPanelRefreshFor(panel)?.isActive).toBe(true);
      editView.unmount();

      expect(getDataSourceMock).not.toHaveBeenCalled();
      act(() => jest.advanceTimersByTime(100));
      act(() => jest.advanceTimersByTime(1));
      if (expectedRuns === 1) {
        expect(runner.getPendingLifecycle()).toMatchObject({ id: 1, origin: RefreshOrigin.Panel });
      } else {
        expect(runner.getPendingLifecycle()).toBeUndefined();
      }
      returnedView.unmount();
    }
  );

  it('keeps interval queries running through the real viewport observer across successive deadlines', async () => {
    const results = new Subject<PanelData>();
    getDataSourceMock.mockResolvedValue(createDatasource());
    runRequestMock.mockReturnValue(results);
    const scheduler = buildPanel('1s');
    const { panel, runner } = scheduler;
    const viewport = installControllableLazyLoaderObserver();
    const Providers = getWrapper({});
    const view = render(
      <Providers>
        <LazyLoader key="panel-loader" mode="query">
          <panel.Component model={panel} />
        </LazyLoader>
      </Providers>
    );
    viewport.change(true);
    viewport.change(false);

    act(() => jest.advanceTimersByTime(1001));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const request = runRequestMock.mock.calls[0][1] as DataQueryRequest;
    act(() => {
      results.next(panelData(LoadingState.Loading, request));
      results.next(panelData(LoadingState.Done, { ...request, endTime: Date.now() }));
    });
    expect(runner.isQueryPending()).toBe(false);

    act(() => jest.advanceTimersByTime(1001));
    expect(runner.getPendingLifecycle()).toMatchObject({ id: 2, origin: RefreshOrigin.Panel });
    view.unmount();
    viewport.restore();
  });
});

interface BuildPanelOptions {
  panelTimeRange?: PanelTimeRange;
  title?: string;
  variables?: SceneVariableSet;
}

function buildPanel(refresh?: string, options: BuildPanelOptions = {}) {
  const timeRange = new SceneTimeRange({ from: 'now-1h', to: 'now' });
  const initialRequest = createRequest('initial', timeRange);
  const runner = new DashboardSceneQueryRunner({
    datasource: { uid: 'test-datasource' },
    queries: [{ refId: 'A' }],
    data: panelData(LoadingState.Done, initialRequest),
  });
  const panel = new VizPanel({
    key: 'panel-1',
    pluginId: 'timeseries',
    title: options.title ?? 'Panel',
    $data: runner,
    $timeRange: options.panelTimeRange,
  });
  setPanelRefreshFor(panel, refresh);
  const scene = new EmbeddedScene({
    $timeRange: timeRange,
    $variables: options.variables,
    body: panel,
  });
  const panelTimeRange = panel.state.$timeRange instanceof PanelTimeRange ? panel.state.$timeRange : undefined;
  return { panel, panelTimeRange, runner, scene, timeRange };
}

function activateScheduler({ panel }: ReturnType<typeof buildPanel>): () => void {
  return panel.activate();
}

function buildDashboardPanel(refresh: string) {
  const timeRange = new SceneTimeRange({ from: 'now-1h', to: 'now' });
  const runner = new DashboardSceneQueryRunner({
    datasource: { uid: 'test-datasource' },
    queries: [{ refId: 'A' }],
    data: panelData(LoadingState.Done, createRequest('initial', timeRange)),
  });
  const panel = new VizPanel({
    key: 'panel-1',
    pluginId: 'timeseries',
    title: 'Panel',
    $data: runner,
  });
  setPanelRefreshFor(panel, refresh);
  const dashboard = new DashboardScene({
    $timeRange: timeRange,
    body: DefaultGridLayoutManager.fromVizPanels([panel]),
    preload: true,
  });

  return { dashboard, panel, runner };
}

function renderDashboardBody(dashboard: DashboardScene) {
  return <dashboard.state.body.Component model={dashboard.state.body} />;
}

function installControllableLazyLoaderObserver() {
  const originalObserver = LazyLoader.observer;
  let target: HTMLElement | undefined;
  LazyLoader.observer = {
    observe: (element: Element) => {
      target = element as HTMLElement;
    },
    unobserve: jest.fn(),
    disconnect: jest.fn(),
  } as unknown as IntersectionObserver;

  return {
    change(isIntersecting: boolean) {
      if (!target) {
        throw new Error('LazyLoader did not observe the panel');
      }
      const observedTarget = target;

      act(() => {
        LazyLoader.callbacks[observedTarget.id]?.({
          target: observedTarget,
          isIntersecting,
        } as unknown as IntersectionObserverEntry);
      });
    },
    restore() {
      LazyLoader.observer = originalObserver;
    },
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
}
