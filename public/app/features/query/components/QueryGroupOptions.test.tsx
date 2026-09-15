import { render, screen, userEvent } from 'test/test-utils';

import { type DataSourceApi, type PanelData } from '@grafana/data';
import { config } from '@grafana/runtime';

import { QueryGroupOptionsEditor } from './QueryGroupOptions';

describe('QueryGroupOptionsEditor panel refresh', () => {
  const originalFeatureToggle = config.featureToggles.panelRefreshOverride;

  afterEach(() => {
    config.featureToggles.panelRefreshOverride = originalFeatureToggle;
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
