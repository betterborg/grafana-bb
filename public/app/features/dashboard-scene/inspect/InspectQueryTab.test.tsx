import { act, render, screen } from '@testing-library/react';
import { getWrapper } from 'test/test-utils';

import { dateTimeFormat, getDefaultTimeRange, LoadingState, type PanelData } from '@grafana/data';
import { getPanelPlugin } from '@grafana/data/test';
import { config, setPluginImportUtils } from '@grafana/runtime';
import { VizPanel } from '@grafana/scenes';

import { DashboardControls } from '../scene/DashboardControls';
import { DashboardRefreshPicker } from '../scene/DashboardRefreshPicker';
import { DashboardScene } from '../scene/DashboardScene';
import { DashboardSceneQueryRunner } from '../scene/DashboardSceneQueryRunner';
import { DefaultGridLayoutManager } from '../scene/layout-default/DefaultGridLayoutManager';
import { getPanelRefreshFor, setPanelRefreshFor } from '../scene/panel-refresh/PanelRefresh';

import { InspectQueryTab } from './InspectQueryTab';

const panelPlugin = getPanelPlugin({ id: 'timeseries' }, () => null);

setPluginImportUtils({
  importPanelPlugin: () => Promise.resolve(panelPlugin),
  getPanelPluginFromCache: () => panelPlugin,
});

jest.mock('app/features/inspector/QueryInspector', () => ({
  QueryInspector: () => <div>Existing query inspector</div>,
}));

describe('InspectQueryTab refresh policy', () => {
  beforeEach(() => {
    config.featureToggles.panelRefreshOverride = true;
  });

  afterEach(() => {
    config.featureToggles.panelRefreshOverride = undefined;
    jest.restoreAllMocks();
  });

  it('shows the effective dashboard interval for a default panel', () => {
    const { tab } = buildScene(undefined, '30s');

    renderTab(tab);

    expect(screen.getByText('Refresh policy:')).toBeInTheDocument();
    expect(screen.getByText('Dashboard refreshes every 30s')).toBeInTheDocument();
    expect(screen.getByText('Freshness:')).toBeInTheDocument();
    expect(screen.getByText('Not updated yet')).toBeInTheDocument();
  });

  it('shows the effective dashboard Off policy for a default panel', () => {
    const { tab } = buildScene(undefined, '');

    renderTab(tab);

    expect(screen.getByText('Automatic dashboard refresh is off')).toBeInTheDocument();
  });

  it('shows an explicit panel interval instead of the dashboard interval', () => {
    const { tab } = buildScene('1m', '30s');

    renderTab(tab);

    expect(screen.getByText('Panel refreshes every 1m')).toBeInTheDocument();
    expect(screen.queryByText('Dashboard refreshes every 30s')).not.toBeInTheDocument();
  });

  it('shows an explicit Off policy', () => {
    const { tab } = buildScene('off', '30s');

    renderTab(tab);

    expect(screen.getByText('Automatic panel refresh is off')).toBeInTheDocument();
  });

  it('shows freshness from the panel refresh controller', () => {
    const { tab, panel } = buildScene(undefined, '30s');
    const lastUpdated = 2_000;
    getPanelRefreshFor(panel)!.setState({ lastUpdated });

    renderTab(tab);

    expect(screen.getByText(`Updated ${dateTimeFormat(lastUpdated, { timeZone: 'browser' })}`)).toBeInTheDocument();
  });

  it('shows the same streaming freshness tracked by the panel indicator', () => {
    const { tab, panel, runner } = buildScene('30s', '1m');
    const now = 3_000;
    jest.spyOn(Date, 'now').mockReturnValue(now);
    const deactivate = panel.activate();

    act(() => runner.setState({ data: getPanelData(LoadingState.Streaming) }));
    renderTab(tab);

    expect(getPanelRefreshFor(panel)!.state.lastUpdated).toBe(now);
    expect(screen.getByText(`Updated ${dateTimeFormat(now, { timeZone: 'browser' })}`)).toBeInTheDocument();
    act(() => deactivate());
  });

  it('retains the existing inspector when the feature toggle is disabled', () => {
    config.featureToggles.panelRefreshOverride = false;
    const { tab } = buildScene('30s', '1m');

    renderTab(tab);

    expect(screen.getByText('Existing query inspector')).toBeInTheDocument();
    expect(screen.queryByText('Refresh policy:')).not.toBeInTheDocument();
    expect(screen.queryByText('Freshness:')).not.toBeInTheDocument();
    expect(screen.queryByText('Panel refreshes every 30s')).not.toBeInTheDocument();
  });
});

function buildScene(panelRefresh: string | undefined, dashboardRefresh: string) {
  const runner = new DashboardSceneQueryRunner({
    datasource: { uid: 'test-datasource' },
    queries: [{ refId: 'A' }],
    data: getPanelData(LoadingState.Done),
  });
  const panel = new VizPanel({
    key: 'panel-1',
    pluginId: 'timeseries',
    title: 'Panel',
    $data: runner,
  });
  setPanelRefreshFor(panel, panelRefresh);
  new DashboardScene({
    controls: new DashboardControls({
      refreshPicker: new DashboardRefreshPicker({ refresh: dashboardRefresh }),
    }),
    body: DefaultGridLayoutManager.fromVizPanels([panel]),
  });
  const tab = new InspectQueryTab({ panelRef: panel.getRef() });

  return { panel, runner, tab };
}

function renderTab(tab: InspectQueryTab) {
  const Wrapper = getWrapper({});
  return render(
    <Wrapper>
      <tab.Component model={tab} />
    </Wrapper>
  );
}

function getPanelData(state: LoadingState): PanelData {
  return {
    state,
    series: [],
    timeRange: getDefaultTimeRange(),
  };
}
