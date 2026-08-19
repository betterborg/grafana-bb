import { waitFor } from '@testing-library/react';
import { of } from 'rxjs';

import { FieldType, LoadingState, type PanelData, getDefaultTimeRange, toDataFrame } from '@grafana/data';
import { getPanelPlugin } from '@grafana/data/test';
import { config, setPluginImportUtils, setRunRequest } from '@grafana/runtime';
import {
  SceneCanvasText,
  type SceneDataTransformer,
  SceneFlexItem,
  SceneFlexLayout,
  sceneGraph,
  SceneGridLayout,
  SceneQueryRunner,
  SceneRefreshPicker,
  SceneTimePicker,
  SceneTimeRange,
  VizPanel,
} from '@grafana/scenes';
import { type LibraryPanel } from '@grafana/schema';
import * as libpanels from 'app/features/library-panels/state/api';
import { NotebookScene } from 'app/features/notebook/scene/NotebookScene';
import { NotebookCellItem } from 'app/features/notebook/scene/layout-notebook/NotebookCellItem';
import { NotebookLayoutManager } from 'app/features/notebook/scene/layout-notebook/NotebookLayoutManager';

import { vizPanelToPanel } from '../serialization/transformSceneToSaveModel';
import { NEW_LINK } from '../settings/links/utils';
import { activateFullSceneTree } from '../utils/test-utils';
import { getPanelIdForVizPanel, getQueryRunnerFor } from '../utils/utils';

import { DashboardScene } from './DashboardScene';
import { DashboardSceneQueryRunner } from './DashboardSceneQueryRunner';
import { LibraryPanelBehavior } from './LibraryPanelBehavior';
import { type VizPanelLinks } from './PanelLinks';
import { DashboardGridItem } from './layout-default/DashboardGridItem';
import { DefaultGridLayoutManager } from './layout-default/DefaultGridLayoutManager';
import { getPanelRefreshFor } from './panel-refresh/PanelRefresh';
import { PanelTimeRange } from './panel-timerange/PanelTimeRange';

setPluginImportUtils({
  importPanelPlugin: (id: string) => Promise.resolve(getPanelPlugin({})),
  getPanelPluginFromCache: (id: string) => undefined,
});

jest.mock('@grafana/runtime', () => ({
  ...jest.requireActual('@grafana/runtime'),
  setPluginExtensionGetter: jest.fn(),
  getPluginLinkExtensions: jest.fn(() => ({
    extensions: [],
  })),
  getDataSourceSrv: () => {
    return {
      get: jest.fn().mockResolvedValue({
        getRef: () => ({ uid: 'ds1' }),
      }),
      getInstanceSettings: jest.fn().mockResolvedValue({ uid: 'ds1' }),
    };
  },
}));

const runRequestMock = jest.fn().mockReturnValue(
  of<PanelData>({
    state: LoadingState.Done,
    timeRange: getDefaultTimeRange(),
    series: [
      toDataFrame({
        fields: [{ name: 'value', type: FieldType.number, values: [1, 2, 3] }],
      }),
    ],
    request: {
      app: 'dashboard',
      requestId: 'request-id',
      dashboardUID: 'asd',
      interval: '1s',
      panelId: 1,
      range: getDefaultTimeRange(),
      targets: [],
      timezone: 'utc',
      intervalMs: 1000,
      startTime: 1,
      scopedVars: {
        __sceneObject: { value: new SceneCanvasText({ text: 'asd' }) },
      },
    },
  })
);

setRunRequest(runRequestMock);

describe('LibraryPanelBehavior', () => {
  it('should load library panel', async () => {
    const { gridItem, spy, behavior } = await buildTestSceneWithLibraryPanel();

    expect(behavior.state.isLoaded).toBe(true);
    expect(behavior.state._loadedPanel).toBeDefined();
    expect(behavior.state._loadedPanel?.model).toBeDefined();
    expect(behavior.state._loadedPanel?.name).toBe('LibraryPanel A');
    expect(behavior.state._loadedPanel?.type).toBe('table');

    // Verify the viz panel state have been updated with lib panel options
    expect(gridItem.state.body.state.options).toEqual({ showHeader: true });

    expect(spy).toHaveBeenCalled();
  });

  it('should include panel links', async () => {
    const { scene } = await buildTestSceneWithLibraryPanel();

    const panel = sceneGraph.findByKey(scene, 'panel-1') as VizPanel;
    expect(panel.state.titleItems).toBeDefined();
    const items = panel.state.titleItems as VizPanelLinks[];
    expect(items[0].state.rawLinks![0].title).toBe('link1');
  });

  it('should set panel timeRange if panel has query options set', async () => {
    const { gridItem } = await buildTestSceneWithLibraryPanel();

    const behavior = gridItem.state.body.state.$behaviors![0] as LibraryPanelBehavior;
    expect(behavior).toBeDefined();
    expect(gridItem.state.body.state.$timeRange).toBeUndefined();

    const panel = vizPanelToPanel(gridItem.state.body.clone({ $behaviors: undefined }));
    panel.timeFrom = '2h';
    panel.timeShift = '3h';

    const libraryPanelState = {
      name: 'LibraryPanel B',
      title: 'LibraryPanel B title',
      uid: '222',
      type: 'table',
      version: 2,
      model: panel,
    };

    behavior.setPanelFromLibPanel(libraryPanelState);

    expect(gridItem.state.body.state.$timeRange).toBeInstanceOf(PanelTimeRange);
  });

  it('should not update panel if version is the same', async () => {
    const { gridItem } = await buildTestSceneWithLibraryPanel();

    const behavior = gridItem.state.body.state.$behaviors![0] as LibraryPanelBehavior;
    expect(behavior).toBeDefined();

    const panel = vizPanelToPanel(gridItem.state.body.clone({ $behaviors: undefined }));

    const libraryPanelState = {
      name: 'LibraryPanel B',
      title: 'LibraryPanel B title',
      uid: '222',
      type: 'table',
      version: 1,
      model: panel,
    };

    behavior.setPanelFromLibPanel(libraryPanelState);

    expect(behavior.state._loadedPanel?.name).toBe('LibraryPanel A');
    expect(behavior.state._loadedPanel?.uid).toBe('111');
  });

  it('should set the title to the library panel title if the feature toggle is enabled', async () => {
    config.featureToggles.preferLibraryPanelTitle = true;
    const { gridItem } = await buildTestSceneWithLibraryPanel();

    expect(gridItem.state.body.state.title).toBe('LibraryPanel A title');
    config.featureToggles.preferLibraryPanelTitle = false;
  });

  it('should set the title to the panel title if the feature toggle is disabled', async () => {
    config.featureToggles.preferLibraryPanelTitle = false;
    const { gridItem } = await buildTestSceneWithLibraryPanel();

    expect(gridItem.state.body.state.title).toBe('Panel A');
  });

  it('should not update panel if behavior not part of a vizPanel', async () => {
    const { gridItem } = await buildTestSceneWithLibraryPanel();

    const behavior = gridItem.state.body.state.$behaviors![0] as LibraryPanelBehavior;
    expect(behavior).toBeDefined();

    const panel = vizPanelToPanel(gridItem.state.body.clone({ $behaviors: undefined }));

    const libraryPanelState = {
      name: 'LibraryPanel B',
      title: 'LibraryPanel B title',
      uid: '222',
      type: 'table',
      version: 2,
      model: panel,
    };

    const behaviorClone = behavior.clone();
    behaviorClone.setPanelFromLibPanel(libraryPanelState);

    expect(behaviorClone.state._loadedPanel?.name).toBe('LibraryPanel A');
    expect(behaviorClone.state._loadedPanel?.uid).toBe('111');
  });

  describe('hoverHeader', () => {
    it('should set hoverHeader to false when library panel has a title', async () => {
      const { gridItem } = await buildTestSceneWithLibraryPanel();

      expect(gridItem.state.body.state.hoverHeader).toBe(false);
    });

    it('should set hoverHeader to true when library panel has no title', async () => {
      const { gridItem } = await buildTestSceneWithLibraryPanel({
        vizPanelTitle: '',
        libPanelModelTitle: '',
      });

      expect(gridItem.state.body.state.hoverHeader).toBe(true);
    });

    it('should set hoverHeader to false when library panel has a time override', async () => {
      const { gridItem } = await buildTestSceneWithLibraryPanel({
        vizPanelTitle: '',
        libPanelModelTitle: '',
        timeFrom: '2h',
      });

      expect(gridItem.state.body.state.hoverHeader).toBe(false);
    });
  });

  it('should use dashboard panel ID for data provider filtering', async () => {
    const { gridItem } = await buildTestSceneWithLibraryPanel();

    const vizPanel = gridItem.state.body;

    // Get the dashboard panel ID from the VizPanel key
    const dashboardPanelId = getPanelIdForVizPanel(vizPanel);
    expect(dashboardPanelId).toBe(1); // Based on key 'panel-1'

    // Verify the data provider uses the dashboard panel ID for filtering
    const dataProvider = vizPanel.state.$data as SceneDataTransformer;
    expect(dataProvider).toBeDefined();

    // Access the SceneQueryRunner through the SceneDataTransformer
    const queryRunner = dataProvider.state?.$data as SceneQueryRunner;
    expect(queryRunner?.state?.dataLayerFilter?.panelId).toBe(dashboardPanelId);
  });

  describe('panel refresh root boundary', () => {
    const previousToggle = config.featureToggles.panelRefreshOverride;

    afterEach(() => {
      config.featureToggles.panelRefreshOverride = previousToggle;
    });

    it('loads and replaces dashboard policies with one controller per panel', async () => {
      config.featureToggles.panelRefreshOverride = true;

      const first = await buildTestSceneWithLibraryPanel({ refresh: '30s' });
      const second = await buildTestSceneWithLibraryPanel({ refresh: '30s' });
      const firstPanel = first.gridItem.state.body;
      const secondPanel = second.gridItem.state.body;
      const firstController = getPanelRefreshFor(firstPanel);
      const secondController = getPanelRefreshFor(secondPanel);

      expect(firstController?.state.refresh).toBe('30s');
      expect(secondController?.state.refresh).toBe('30s');
      expect(firstController).not.toBe(secondController);
      expect(firstPanel.state.$timeRange).toBeInstanceOf(PanelTimeRange);
      expect(getQueryRunnerFor(firstPanel)).toBeInstanceOf(DashboardSceneQueryRunner);

      first.behavior.setPanelFromLibPanel(buildLibraryPanel({ uid: '111', version: 2, refresh: 'off' }));

      expect(getPanelRefreshFor(firstPanel)).toBe(firstController);
      expect(firstController?.state.refresh).toBe('off');
      expect(firstPanel.state.$timeRange).toBeInstanceOf(PanelTimeRange);

      first.behavior.setPanelFromLibPanel(buildLibraryPanel({ uid: '111', version: 3 }));

      expect(getPanelRefreshFor(firstPanel)).toBe(firstController);
      expect(firstController?.state.refresh).toBeUndefined();
      expect(firstPanel.state.$timeRange).toBeUndefined();
    });

    it.each(['30s', 'off'])('keeps a titleless library panel with %s policy always visible', async (refresh) => {
      config.featureToggles.panelRefreshOverride = true;

      const { gridItem, behavior } = await buildTestSceneWithLibraryPanel({
        refresh,
        vizPanelTitle: '',
        libPanelModelTitle: '',
      });
      const panel = gridItem.state.body;
      expect(panel.state.hoverHeader).toBe(false);

      behavior.setPanelFromLibPanel(buildLibraryPanel({ uid: '111', version: 2, refresh, title: '' }));
      expect(panel.state.hoverHeader).toBe(false);

      behavior.setPanelFromLibPanel(buildLibraryPanel({ uid: '111', version: 3, title: '' }));
      expect(panel.state.hoverHeader).toBe(true);
    });

    it('preserves a dashboard policy without installing interception when the feature is disabled', async () => {
      config.featureToggles.panelRefreshOverride = false;

      const { gridItem } = await buildTestSceneWithLibraryPanel({ refresh: '30s' });

      expect(getPanelRefreshFor(gridItem.state.body)?.state.refresh).toBe('30s');
      expect(gridItem.state.body.state.$timeRange).toBeUndefined();
    });

    it('keeps asynchronous Notebook loads and replacements root-neutral', async () => {
      config.featureToggles.panelRefreshOverride = true;
      const behavior = new LibraryPanelBehavior({ name: 'LibraryPanel A', uid: 'notebook-lib' });
      const panel = new VizPanel({
        key: 'panel-2',
        pluginId: LibraryPanelBehavior.LOADING_VIZ_PANEL_PLUGIN_ID,
        $behaviors: [behavior],
      });
      const notebook = new NotebookScene({
        title: 'Notebook',
        body: new NotebookLayoutManager({
          cells: [new NotebookCellItem({ elementName: 'library', source: 'user', body: panel })],
        }),
        $timeRange: new SceneTimeRange({}),
        timePicker: new SceneTimePicker({}),
        refreshPicker: new SceneRefreshPicker({}),
      });
      jest
        .spyOn(libpanels, 'getLibraryPanel')
        .mockResolvedValue(buildLibraryPanel({ uid: 'notebook-lib', refresh: '30s' }));

      const deactivate = activateFullSceneTree(notebook);
      await waitFor(() => expect(behavior.state.isLoaded).toBe(true));

      expect(getPanelRefreshFor(panel)).toBeUndefined();
      expect(panel.state.$timeRange).toBeUndefined();
      expect(getQueryRunnerFor(panel)).toBeInstanceOf(SceneQueryRunner);
      expect(getQueryRunnerFor(panel)).not.toBeInstanceOf(DashboardSceneQueryRunner);

      behavior.setPanelFromLibPanel(buildLibraryPanel({ uid: 'notebook-lib', version: 2, refresh: 'off' }));

      expect(getPanelRefreshFor(panel)).toBeUndefined();
      expect(panel.state.$timeRange).toBeUndefined();
      expect(getQueryRunnerFor(panel)).toBeInstanceOf(SceneQueryRunner);
      expect(getQueryRunnerFor(panel)).not.toBeInstanceOf(DashboardSceneQueryRunner);
      deactivate();
    });
  });

  // Repeat carried on the library panel definition is migrated onto the enclosing DashboardGridItem.
  // Under dynamic dashboards repeat is owned by the panel instance instead, so the migration is
  // skipped — except for public and scripted dashboards, whose migrations still run in the frontend.
  describe('repeat migration', () => {
    afterEach(() => {
      config.featureToggles.dashboardNewLayouts = false;
    });

    it('migrates repeat onto the grid item for legacy dashboards', async () => {
      config.featureToggles.dashboardNewLayouts = false;

      const { gridItem } = await buildTestSceneWithLibraryPanel({ repeat: 'server' });

      expect(gridItem.state.variableName).toBe('server');
      expect(gridItem.state.repeatDirection).toBe('h');
      expect(gridItem.state.maxPerRow).toBe(4);
    });

    it('skips the migration when dashboardNewLayouts is enabled', async () => {
      config.featureToggles.dashboardNewLayouts = true;

      const { gridItem } = await buildTestSceneWithLibraryPanel({ repeat: 'server' });

      expect(gridItem.state.variableName).toBeUndefined();
    });

    it('still migrates for a public dashboard when dashboardNewLayouts is enabled', async () => {
      config.featureToggles.dashboardNewLayouts = true;

      const { gridItem } = await buildTestSceneWithLibraryPanel({
        repeat: 'server',
        meta: { publicDashboardEnabled: true },
      });

      expect(gridItem.state.variableName).toBe('server');
    });

    it('still migrates for a scripted dashboard when dashboardNewLayouts is enabled', async () => {
      config.featureToggles.dashboardNewLayouts = true;

      const { gridItem } = await buildTestSceneWithLibraryPanel({
        repeat: 'server',
        meta: { fromScript: true },
      });

      expect(gridItem.state.variableName).toBe('server');
    });

    it('leaves the grid item alone when the library panel has no repeat', async () => {
      const { gridItem } = await buildTestSceneWithLibraryPanel();

      expect(gridItem.state.variableName).toBeUndefined();
    });

    // The reason getDashboardSceneFor sits inside the DashboardGridItem branch rather than above it.
    // A notebook cell holding a library panel whose model carries `repeat` has a NotebookCellItem
    // parent and a NotebookScene root, so hoisting the lookup back out throws
    // "SceneObject root is not a DashboardScene" and the cell fails to render. Every other case in
    // this file builds a DashboardScene root, so none of them would catch that.
    it('does not look up the dashboard when the panel is not in a DashboardGridItem', () => {
      const behavior = new LibraryPanelBehavior({ name: 'LibraryPanel A', uid: '111' });
      const vizPanel = new VizPanel({ pluginId: 'lib-panel-loading', key: 'panel-1', $behaviors: [behavior] });

      // Stands in for a NotebookCellItem: a non-DashboardGridItem parent under a root that is not a
      // DashboardScene. Built directly rather than via getLibraryPanel so there is no mock in the path.
      new SceneFlexLayout({ children: [new SceneFlexItem({ body: vizPanel })] });

      expect(() =>
        behavior.setPanelFromLibPanel({
          name: 'LibraryPanel A',
          uid: '111',
          type: 'table',
          version: 1,
          model: {
            title: 'LibraryPanel A title',
            type: 'table',
            options: {},
            fieldConfig: { defaults: {}, overrides: [] },
            targets: [{ refId: 'A' }],
            // The field that reaches the getDashboardSceneFor call.
            repeat: 'server',
            repeatDirection: 'h',
          },
        })
      ).not.toThrow();
    });
  });
});

interface BuildTestSceneOptions {
  vizPanelTitle?: string;
  libPanelModelTitle?: string;
  timeFrom?: string;
  refresh?: string;
  /** Set on the library panel model, to exercise the repeat migration onto the grid item. */
  repeat?: string;
  /** Merged into the dashboard meta, for the public/scripted migration exceptions. */
  meta?: { publicDashboardEnabled?: boolean; fromScript?: boolean };
}

async function buildTestSceneWithLibraryPanel(options: BuildTestSceneOptions = {}) {
  const {
    vizPanelTitle = 'Panel A',
    libPanelModelTitle = 'LibraryPanel A title',
    timeFrom,
    refresh,
    repeat,
    meta,
  } = options;

  const behavior = new LibraryPanelBehavior({ name: 'LibraryPanel A', uid: '111' });

  const vizPanel = new VizPanel({
    title: vizPanelTitle,
    pluginId: 'lib-panel-loading',
    key: 'panel-1',
    $behaviors: [behavior],
  });

  const libraryPanel: LibraryPanel = {
    name: 'LibraryPanel A',
    uid: '111',
    type: 'table',
    model: {
      title: libPanelModelTitle,
      type: 'table',
      links: [{ ...NEW_LINK, title: 'link1' }],
      options: { showHeader: true },
      fieldConfig: { defaults: {}, overrides: [] },
      datasource: { uid: 'abcdef' },
      targets: [{ refId: 'A' }],
      ...(timeFrom ? { timeFrom } : {}),
      ...(refresh ? { refresh } : {}),
      ...(repeat ? { repeat, repeatDirection: 'h', maxPerRow: 4 } : {}),
    },
    version: 1,
  };

  const spy = jest.spyOn(libpanels, 'getLibraryPanel').mockResolvedValue(libraryPanel);

  const gridItem = new DashboardGridItem({
    key: 'griditem-1',
    x: 0,
    y: 0,
    width: 10,
    height: 12,
    body: vizPanel,
  });

  const scene = new DashboardScene({
    title: 'hello',
    uid: 'dash-1',
    meta: {
      canEdit: true,
      ...meta,
    },
    body: new DefaultGridLayoutManager({
      grid: new SceneGridLayout({
        children: [gridItem],
      }),
    }),
  });

  activateFullSceneTree(scene);

  await new Promise((r) => setTimeout(r, 1));

  return { scene, gridItem, spy, behavior };
}

function buildLibraryPanel({
  uid,
  version = 1,
  refresh,
  title = 'LibraryPanel A title',
}: {
  uid: string;
  version?: number;
  refresh?: string;
  title?: string;
}): LibraryPanel {
  return {
    name: 'LibraryPanel A',
    uid,
    type: 'table',
    version,
    model: {
      title,
      type: 'table',
      options: { showHeader: true },
      fieldConfig: { defaults: {}, overrides: [] },
      targets: [{ refId: 'A' }],
      ...(refresh ? { refresh } : {}),
    },
  };
}
