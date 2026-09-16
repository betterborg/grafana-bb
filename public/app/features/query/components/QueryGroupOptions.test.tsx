import { render, screen, userEvent } from 'test/test-utils';

import { type DataSourceApi, type PanelData } from '@grafana/data';
import { config } from '@grafana/runtime';
import { getDashboardSrv } from 'app/features/dashboard/services/DashboardSrv';
import { type DashboardModel } from 'app/features/dashboard/state/DashboardModel';

import { QueryGroupOptionsEditor } from './QueryGroupOptions';

describe('QueryGroupOptionsEditor panel refresh', () => {
  const originalFeatureToggle = config.featureToggles.panelRefreshOverride;

  afterEach(() => {
    config.featureToggles.panelRefreshOverride = originalFeatureToggle;
    getDashboardSrv().setCurrent(undefined);
  });

  it('uses the dashboard refresh intervals as picker suggestions', async () => {
    config.featureToggles.panelRefreshOverride = true;
    getDashboardSrv().setCurrent({ timepicker: { refresh_intervals: ['7s', '13s', '1m'] } } as DashboardModel);

    render(
      <QueryGroupOptionsEditor
        options={{ queries: [], dataSource: {} }}
        dataSource={{ meta: {} } as DataSourceApi}
        data={{} as PanelData}
        onChange={jest.fn()}
      />
    );

    await userEvent.click(screen.getByRole('button', { name: 'Expand query row' }));
    await userEvent.click(screen.getByRole('combobox', { name: 'Panel refresh interval' }));

    expect(screen.getByRole('option', { name: '7s' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: '13s' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: '10s' })).not.toBeInTheDocument();
  });

  it('shows an explicit refresh override in the collapsed summary', () => {
    config.featureToggles.panelRefreshOverride = true;

    render(
      <QueryGroupOptionsEditor
        options={{ queries: [], dataSource: {}, refresh: '10s' }}
        dataSource={{ meta: {} } as DataSourceApi}
        data={{} as PanelData}
        onChange={jest.fn()}
      />
    );

    expect(screen.getByText('Refresh = 10s')).toBeInTheDocument();
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
    await userEvent.click(screen.getByRole('combobox', { name: 'Panel refresh interval' }));
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

    expect(screen.queryByRole('combobox', { name: 'Panel refresh interval' })).not.toBeInTheDocument();
  });
});
