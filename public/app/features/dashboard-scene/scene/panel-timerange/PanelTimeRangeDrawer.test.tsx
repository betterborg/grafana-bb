import { render, screen } from 'test/test-utils';

import { config } from '@grafana/runtime';
import { VizPanel } from '@grafana/scenes';

import * as panelRefresh from '../panel-refresh/PanelRefresh';

import { PanelTimeRange } from './PanelTimeRange';
import { PanelTimeRangeDrawer } from './PanelTimeRangeDrawer';

describe('PanelTimeRangeDrawer panel refresh', () => {
  const originalFeatureToggle = config.featureToggles.panelRefreshOverride;

  beforeEach(() => {
    config.featureToggles.panelRefreshOverride = true;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    config.featureToggles.panelRefreshOverride = originalFeatureToggle;
  });

  it('applies a refresh-only policy through the shared picker and mutation', async () => {
    const panel = buildPanel();
    const drawer = buildDrawer(panel);
    const setPanelRefreshSpy = jest.spyOn(panelRefresh, 'setPanelRefreshFor');
    const { user } = render(<PanelTimeRangeDrawer.Component model={drawer} />);

    await user.click(screen.getByRole('combobox', { name: 'Panel refresh interval' }));
    await user.click(screen.getByRole('option', { name: 'Off' }));
    await user.click(screen.getByRole('button', { name: 'Apply' }));

    expect(setPanelRefreshSpy).toHaveBeenCalledWith(panel, 'off');
    expect(panelRefresh.getPanelRefreshFor(panel)?.state.refresh).toBe('off');
    expect(panel.state.$timeRange).toBeInstanceOf(PanelTimeRange);
  });

  it('removes refresh-only interception when reset to Default', () => {
    const panel = buildPanel();
    const controller = panelRefresh.setPanelRefreshFor(panel, '30s');
    const drawer = buildDrawer(panel);

    drawer.setState({ refresh: undefined });
    drawer.onApply();

    expect(panelRefresh.getPanelRefreshFor(panel)).toBe(controller);
    expect(controller.state.refresh).toBeUndefined();
    expect(panel.state.$timeRange).toBeUndefined();
  });

  it('applies combined time and refresh settings and preserves the time override on Default', () => {
    const panel = buildPanel();
    const drawer = buildDrawer(panel);

    drawer.setState({ timeFrom: '1h', refresh: '30s' });
    drawer.onApply();

    const controller = panelRefresh.getPanelRefreshFor(panel)!;
    const timeRange = panel.state.$timeRange as PanelTimeRange;
    expect(controller.state.refresh).toBe('30s');
    expect(timeRange).toBeInstanceOf(PanelTimeRange);
    expect(timeRange.state.timeFrom).toBe('1h');

    const defaultDrawer = buildDrawer(panel);
    defaultDrawer.setState({ refresh: undefined });
    defaultDrawer.onApply();

    expect(controller.state.refresh).toBeUndefined();
    expect(panel.state.$timeRange).toBe(timeRange);
    expect(timeRange.state.timeFrom).toBe('1h');
  });

  it('hides the shared picker when the feature toggle is disabled', () => {
    config.featureToggles.panelRefreshOverride = false;
    const drawer = buildDrawer(buildPanel());

    render(<PanelTimeRangeDrawer.Component model={drawer} />);

    expect(screen.queryByRole('combobox', { name: 'Panel refresh interval' })).not.toBeInTheDocument();
  });
});

function buildPanel(timeRange?: PanelTimeRange) {
  return new VizPanel({
    key: 'panel-1',
    pluginId: 'timeseries',
    title: 'Panel',
    $timeRange: timeRange,
  });
}

function buildDrawer(panel: VizPanel) {
  const drawer = new PanelTimeRangeDrawer({ panelRef: panel.getRef() });
  drawer.onClose = jest.fn();
  return drawer;
}
