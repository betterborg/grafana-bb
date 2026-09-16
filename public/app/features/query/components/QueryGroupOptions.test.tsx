import { render, screen, userEvent } from 'test/test-utils';

import { type DataSourceApi, type PanelData } from '@grafana/data';
import { config } from '@grafana/runtime';

import { QueryGroupOptionsEditor } from './QueryGroupOptions';

const mockGetCurrentDashboard = jest.fn();

jest.mock('app/features/dashboard/services/DashboardSrv', () => ({
  getDashboardSrv: () => ({ getCurrent: mockGetCurrentDashboard }),
}));

describe('QueryGroupOptionsEditor panel refresh', () => {
  const originalFeatureToggle = config.featureToggles.panelRefreshOverride;

  afterEach(() => {
    config.featureToggles.panelRefreshOverride = originalFeatureToggle;
    mockGetCurrentDashboard.mockReset();
  });

  it('shows the shared picker behind the feature toggle and maps its value into query options', async () => {
    config.featureToggles.panelRefreshOverride = true;
    const onChange = jest.fn();

    render(
      <QueryGroupOptionsEditor
        options={{
          queries: [],
          dataSource: {},
          refresh: undefined,
        }}
        dataSource={{ meta: {} } as DataSourceApi}
        data={{} as PanelData}
        onChange={onChange}
      />
    );

    await userEvent.click(screen.getByRole('button', { name: 'Expand query row' }));
    await userEvent.click(screen.getByRole('combobox', { name: 'Refresh' }));
    await userEvent.click(screen.getByRole('option', { name: 'Off' }));

    expect(onChange).toHaveBeenCalledWith({
      queries: [],
      dataSource: {},
      refresh: 'off',
    });
  });

  it('does not show the picker when the feature toggle is disabled', async () => {
    config.featureToggles.panelRefreshOverride = false;

    render(
      <QueryGroupOptionsEditor
        options={{ queries: [], dataSource: {} }}
        dataSource={{ meta: {} } as DataSourceApi}
        data={{} as PanelData}
        onChange={jest.fn()}
      />
    );

    await userEvent.click(screen.getByRole('button', { name: 'Expand query row' }));

    expect(screen.queryByRole('combobox', { name: 'Refresh' })).not.toBeInTheDocument();
  });

  it('uses dashboard refresh intervals and includes refresh in the collapsed summary', async () => {
    config.featureToggles.panelRefreshOverride = true;
    mockGetCurrentDashboard.mockReturnValue({ timepicker: { refresh_intervals: ['7s', '13s', '1m'] } });

    render(
      <QueryGroupOptionsEditor
        options={{ queries: [], dataSource: {}, refresh: '13s' }}
        dataSource={{ meta: {} } as DataSourceApi}
        data={{} as PanelData}
        onChange={jest.fn()}
      />
    );

    expect(screen.getByText('Refresh = 13s')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Expand query row' }));
    await userEvent.click(screen.getByRole('combobox', { name: 'Refresh' }));

    expect(screen.getByRole('option', { name: '7s' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: '13s' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: '5s' })).not.toBeInTheDocument();
  });

  it('falls back to default refresh intervals when the dashboard value is not an array', async () => {
    config.featureToggles.panelRefreshOverride = true;
    mockGetCurrentDashboard.mockReturnValue({ timepicker: { refresh_intervals: null } });

    render(
      <QueryGroupOptionsEditor
        options={{ queries: [], dataSource: {} }}
        dataSource={{ meta: {} } as DataSourceApi}
        data={{} as PanelData}
        onChange={jest.fn()}
      />
    );

    await userEvent.click(screen.getByRole('button', { name: 'Expand query row' }));
    await userEvent.click(screen.getByRole('combobox', { name: 'Refresh' }));

    expect(screen.getByRole('option', { name: '5s' })).toBeInTheDocument();
  });
});
