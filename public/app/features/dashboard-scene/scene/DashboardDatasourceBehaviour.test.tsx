import { map, of } from 'rxjs';

import {
  type DataQuery,
  type DataQueryRequest,
  type DataSourceApi,
  type DataSourceJsonData,
  type DataSourceRef,
  getDefaultTimeRange,
  LoadingState,
  type PanelData,
} from '@grafana/data';
import { getPanelPlugin } from '@grafana/data/test';
import { config, setPluginImportUtils } from '@grafana/runtime';
import { SceneDataTransformer, SceneFlexLayout, SceneQueryRunner, VizPanel } from '@grafana/scenes';
import { SHARED_DASHBOARD_QUERY, DASHBOARD_DATASOURCE_PLUGIN_ID } from 'app/plugins/datasource/dashboard/constants';
import { MIXED_DATASOURCE_NAME } from 'app/plugins/datasource/mixed/MixedDataSource';

import { activateFullSceneTree } from '../utils/test-utils';

import { DashboardDatasourceBehaviour } from './DashboardDatasourceBehaviour';
import { DashboardScene } from './DashboardScene';
import { DashboardSceneQueryRunner } from './DashboardSceneQueryRunner';
import { LibraryPanelBehavior } from './LibraryPanelBehavior';
import { DefaultGridLayoutManager } from './layout-default/DefaultGridLayoutManager';
import { getPanelRefreshFor, setPanelRefreshFor } from './panel-refresh/PanelRefresh';
import { getRefreshOrigin, RefreshOrigin, runWithRefreshOrigin } from './refresh-origin';

const grafanaDs = {
  id: 1,
  uid: '-- Grafana --',
  name: 'grafana',
  type: 'grafana',
  meta: {
    id: 'grafana',
  },
  getRef: () => {
    return { type: 'grafana', uid: '-- Grafana --' };
  },
};

const dashboardDs: DataSourceApi = {
  meta: {
    id: DASHBOARD_DATASOURCE_PLUGIN_ID,
  },
  name: SHARED_DASHBOARD_QUERY,
  type: SHARED_DASHBOARD_QUERY,
  uid: SHARED_DASHBOARD_QUERY,
  getRef: () => {
    return { type: SHARED_DASHBOARD_QUERY, uid: SHARED_DASHBOARD_QUERY };
  },
} as DataSourceApi<DataQuery, DataSourceJsonData, {}>;

const mixedDs: DataSourceApi = {
  meta: {
    id: 'mixed',
  },
  name: MIXED_DATASOURCE_NAME,
  type: MIXED_DATASOURCE_NAME,
  uid: MIXED_DATASOURCE_NAME,
  getRef: () => {
    return { type: MIXED_DATASOURCE_NAME, uid: MIXED_DATASOURCE_NAME };
  },
} as DataSourceApi<DataQuery, DataSourceJsonData, {}>;

setPluginImportUtils({
  importPanelPlugin: (id: string) => Promise.resolve(getPanelPlugin({})),
  getPanelPluginFromCache: (id: string) => undefined,
});

const runRequestMock = jest.fn().mockImplementation((ds: DataSourceApi, request: DataQueryRequest) => {
  const result: PanelData = {
    state: LoadingState.Loading,
    series: [],
    timeRange: request.range,
    request,
  };

  return of([]).pipe(
    map(() => {
      result.state = LoadingState.Done;
      result.series = [];

      return result;
    })
  );
});

jest.mock('@grafana/runtime', () => ({
  ...jest.requireActual('@grafana/runtime'),
  getRunRequest: () => (ds: DataSourceApi, request: DataQueryRequest) => {
    return runRequestMock(ds, request);
  },
  getDataSourceSrv: () => {
    return {
      get: async (ref: DataSourceRef) => {
        if (ref.uid === 'grafana') {
          return grafanaDs;
        }

        if (ref.uid === SHARED_DASHBOARD_QUERY) {
          return dashboardDs;
        }

        if (ref.uid === MIXED_DATASOURCE_NAME) {
          return mixedDs;
        }

        return null;
      },
      getInstanceSettings: jest.fn().mockResolvedValue({ uid: 'ds1' }),
    };
  },
}));

describe('DashboardDatasourceBehaviour', () => {
  describe('Given scene with a dashboard DS panel and a source panel', () => {
    let scene: DashboardScene, sourcePanel: VizPanel, dashboardDSPanel: VizPanel, sceneDeactivate: () => void;

    beforeEach(async () => {
      ({ scene, sourcePanel, dashboardDSPanel, sceneDeactivate } = await buildTestScene());
    });

    it('Should re-run query of dashboardDS panel when source query re-runs', async () => {
      // spy on runQueries that will be called by the behaviour
      const spy = jest.spyOn(dashboardDSPanel.state.$data!.state.$data as SceneQueryRunner, 'runQueries');

      // deactivate scene to mimic going into panel edit
      sceneDeactivate();
      // run source panel queries and update request ID
      (sourcePanel.state.$data!.state.$data as SceneQueryRunner).runQueries();

      await new Promise((r) => setTimeout(r, 1));

      // activate scene to mimic coming back from panel edit
      activateFullSceneTree(scene);

      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('Should not run query of dashboardDS panel when source panel queries do not change', async () => {
      // spy on runQueries
      const spy = jest.spyOn(dashboardDSPanel.state.$data!.state.$data as SceneQueryRunner, 'runQueries');

      // deactivate scene to mimic going into panel edit
      sceneDeactivate();

      await new Promise((r) => setTimeout(r, 1));

      // activate scene to mimic coming back from panel edit
      activateFullSceneTree(scene);

      expect(spy).not.toHaveBeenCalled();
    });

    it('Should not re-run queries in behaviour when adding a dashboardDS panel to the scene', async () => {
      const sourcePanel = new VizPanel({
        title: 'Panel A',
        pluginId: 'table',
        key: 'panel-1',
        $data: new SceneQueryRunner({
          datasource: { uid: 'grafana' },
          queries: [{ refId: 'A', queryType: 'randomWalk' }],
        }),
      });

      const behaviour = new DashboardDatasourceBehaviour({});

      const dashboardDSPanel = new VizPanel({
        title: 'Panel B',
        pluginId: 'table',
        key: 'panel-2',
        $data: new SceneQueryRunner({
          datasource: { uid: SHARED_DASHBOARD_QUERY },
          queries: [{ refId: 'A', panelId: 1 }],
          $behaviors: [behaviour],
        }),
      });

      const scene = new DashboardScene({
        title: 'hello',
        uid: 'dash-1',
        meta: {
          canEdit: true,
        },
        body: DefaultGridLayoutManager.fromVizPanels([sourcePanel]),
      });

      activateFullSceneTree(scene);

      await new Promise((r) => setTimeout(r, 1));

      const spy = jest.spyOn(dashboardDSPanel.state.$data as SceneQueryRunner, 'runQueries');

      //const layout = scene.state.body as DefaultGridLayoutManager;

      // we add the new panel, it should run it's query as usual
      scene.addPanel(dashboardDSPanel);

      dashboardDSPanel.activate();

      expect(spy).toHaveBeenCalledTimes(1);
      // since there is no previous request ID on dashboard load, the behaviour should not re-run queries
      expect(behaviour['prevRequestIds'].size).toBe(0);
    });

    it('Should re-run queries when source panel data arrives on scene load', async () => {
      const sourcePanel = new VizPanel({
        title: 'Panel A',
        pluginId: 'table',
        key: 'panel-1',
        $data: new SceneQueryRunner({
          datasource: { uid: 'grafana' },
          queries: [{ refId: 'A', queryType: 'randomWalk' }],
        }),
      });

      const behaviour = new DashboardDatasourceBehaviour({});

      const dashboardDSPanel = new VizPanel({
        title: 'Panel B',
        pluginId: 'table',
        key: 'panel-2',
        $data: new SceneQueryRunner({
          datasource: { uid: SHARED_DASHBOARD_QUERY },
          queries: [{ refId: 'A', panelId: 1 }],
          $behaviors: [behaviour],
        }),
      });

      const scene = new DashboardScene({
        title: 'hello',
        uid: 'dash-1',
        meta: {
          canEdit: true,
        },
        body: DefaultGridLayoutManager.fromVizPanels([sourcePanel, dashboardDSPanel]),
      });

      const spy = jest.spyOn(dashboardDSPanel.state.$data as SceneQueryRunner, 'runQueries');

      activateFullSceneTree(scene);

      await new Promise((r) => setTimeout(r, 1));

      // Called twice: once for the initial activation query, and once when the
      // source panel's data arrives via the onSourceDataChange subscription.
      // The second call ensures the dashboard DS panel picks up the source
      // panel's completed data (prevents stale data when it activates first).
      expect(spy).toHaveBeenCalledTimes(2);
      // prevRequestIds should still be empty — no deactivate/reactivate cycle occurred
      expect(behaviour['prevRequestIds'].size).toBe(0);
    });

    it('Should exit behaviour early if not in a dashboard scene', async () => {
      // spy on runQueries
      const spy = jest.spyOn(dashboardDSPanel.state.$data!.state.$data as SceneQueryRunner, 'runQueries');

      const scene = new SceneFlexLayout({
        $data: dashboardDSPanel.state.$data?.clone(),
        children: [],
      });

      scene.activate();

      expect(spy).not.toHaveBeenCalled();
    });

    it('Should not re-run queries if dashboard DS panel references an invalid source panel', async () => {
      const sourcePanel = new VizPanel({
        title: 'Panel A',
        pluginId: 'table',
        key: 'panel-1',
        $data: new SceneQueryRunner({
          datasource: { uid: 'grafana' },
          queries: [{ refId: 'A', queryType: 'randomWalk' }],
        }),
      });

      // query references inexistent panel
      const dashboardDSPanel = new VizPanel({
        title: 'Panel B',
        pluginId: 'table',
        key: 'panel-2',
        $data: new SceneQueryRunner({
          datasource: { uid: SHARED_DASHBOARD_QUERY },
          queries: [{ refId: 'A', panelId: 10 }],
          $behaviors: [new DashboardDatasourceBehaviour({})],
        }),
      });

      const scene = new DashboardScene({
        title: 'hello',
        uid: 'dash-1',
        meta: {
          canEdit: true,
        },
        body: DefaultGridLayoutManager.fromVizPanels([sourcePanel, dashboardDSPanel]),
      });

      const sceneDeactivate = activateFullSceneTree(scene);

      await new Promise((r) => setTimeout(r, 1));

      // spy on runQueries
      const spy = jest.spyOn(dashboardDSPanel.state.$data as SceneQueryRunner, 'runQueries');

      // deactivate scene to mimic going into panel edit
      sceneDeactivate();

      await new Promise((r) => setTimeout(r, 1));

      // activate scene to mimic coming back from panel edit
      activateFullSceneTree(scene);

      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe('Given scene with no DashboardDS panel', () => {
    it('Should not re-run queries and exit early in behaviour', async () => {
      const sourcePanel = new VizPanel({
        title: 'Panel A',
        pluginId: 'table',
        key: 'panel-1',
        $data: new SceneQueryRunner({
          datasource: { uid: 'grafana' },
          queries: [{ refId: 'A', queryType: 'randomWalk' }],
        }),
      });

      const anotherPanel = new VizPanel({
        title: 'Panel B',
        pluginId: 'table',
        key: 'panel-2',
        $data: new SceneQueryRunner({
          datasource: { uid: 'grafana' },
          queries: [{ refId: 'A', queryType: 'randomWalk' }],
        }),
      });

      const scene = new DashboardScene({
        title: 'hello',
        uid: 'dash-1',
        meta: {
          canEdit: true,
        },
        body: DefaultGridLayoutManager.fromVizPanels([sourcePanel, anotherPanel]),
      });

      const sceneDeactivate = activateFullSceneTree(scene);

      await new Promise((r) => setTimeout(r, 1));

      // spy on runQueries
      const spy = jest.spyOn(anotherPanel.state.$data as SceneQueryRunner, 'runQueries');

      // deactivate scene to mimic going into panel edit
      sceneDeactivate();
      // run source panel queries and update request ID
      (sourcePanel.state.$data as SceneQueryRunner).runQueries();

      await new Promise((r) => setTimeout(r, 1));

      // activate scene to mimic coming back from panel edit
      activateFullSceneTree(scene);

      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe('Given an invalid state', () => {
    it('Should throw an error if behaviour is not attached to a SceneQueryRunner', () => {
      const behaviour = new DashboardDatasourceBehaviour({});

      expect(() => behaviour.activate()).toThrow('DashboardDatasourceBehaviour must be attached to a SceneQueryRunner');
    });

    it('Should throw an error if source panel does not have a SceneQueryRunner', async () => {
      const sourcePanel = new VizPanel({
        title: 'Panel A',
        pluginId: 'table',
        key: 'panel-1',
        $data: undefined,
      });

      const dashboardDSPanel = new VizPanel({
        title: 'Panel B',
        pluginId: 'table',
        key: 'panel-2',
        $data: new SceneQueryRunner({
          datasource: { uid: SHARED_DASHBOARD_QUERY },
          queries: [{ refId: 'A', panelId: 1 }],
          $behaviors: [new DashboardDatasourceBehaviour({})],
        }),
      });

      const scene = new DashboardScene({
        title: 'hello',
        uid: 'dash-1',
        meta: {
          canEdit: true,
        },
        body: DefaultGridLayoutManager.fromVizPanels([sourcePanel, dashboardDSPanel]),
      });

      try {
        activateFullSceneTree(scene);
      } catch (e) {
        expect(e).toEqual(new Error('Could not find SceneQueryRunner for panel'));
      }
    });
  });

  describe('Library panels', () => {
    it('should re-run queries when library panel re-runs query', async () => {
      const libPanelBehavior = new LibraryPanelBehavior({
        isLoaded: false,
        uid: 'fdcvggvfy2qdca',
        name: 'My Library Panel',
        _loadedPanel: undefined,
      });

      const sourcePanel = new VizPanel({
        key: 'panel-1',
        title: 'Panel A',
        pluginId: 'table',
        $behaviors: [libPanelBehavior],
        $data: new SceneQueryRunner({
          datasource: { uid: 'grafana' },
          queries: [{ refId: 'A', queryType: 'randomWalk' }],
        }),
      });

      // query references inexistent panel
      const dashboardDSPanel = new VizPanel({
        title: 'Panel B',
        pluginId: 'table',
        key: 'panel-2',
        $data: new SceneQueryRunner({
          datasource: { uid: SHARED_DASHBOARD_QUERY },
          queries: [{ refId: 'A', panelId: 1 }],
          $behaviors: [new DashboardDatasourceBehaviour({})],
        }),
      });

      const scene = new DashboardScene({
        title: 'hello',
        uid: 'dash-1',
        meta: {
          canEdit: true,
        },
        body: DefaultGridLayoutManager.fromVizPanels([sourcePanel, dashboardDSPanel]),
      });

      const sceneDeactivate = activateFullSceneTree(scene);

      // spy on runQueries
      const spy = jest.spyOn(dashboardDSPanel.state.$data as SceneQueryRunner, 'runQueries');

      // deactivate scene to mimic going into panel edit
      sceneDeactivate();

      // run source panel queries and update request ID
      (sourcePanel.state.$data as SceneQueryRunner).runQueries();

      // // activate scene to mimic coming back from panel edit
      activateFullSceneTree(scene);

      await new Promise((r) => setTimeout(r, 1));

      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('should wait for library panel to load before running queries', async () => {
      jest.spyOn(console, 'error').mockImplementation();
      const libPanelBehavior = new LibraryPanelBehavior({
        isLoaded: false,
        uid: 'fdcvggvfy2qdca',
        name: 'My Library Panel',
        _loadedPanel: undefined,
      });

      const sourcePanel = new VizPanel({
        key: 'panel-1',
        title: 'Panel A',
        pluginId: 'table',
        $behaviors: [libPanelBehavior],
        $data: new SceneQueryRunner({
          datasource: { uid: 'grafana' },
          queries: [{ refId: 'A', queryType: 'randomWalk' }],
        }),
      });

      // query references inexistent panel
      const dashboardDSPanel = new VizPanel({
        title: 'Panel B',
        pluginId: 'table',
        key: 'panel-2',
        $data: new SceneQueryRunner({
          datasource: { uid: SHARED_DASHBOARD_QUERY },
          queries: [{ refId: 'A', panelId: 1 }],
          $behaviors: [new DashboardDatasourceBehaviour({})],
        }),
      });

      const scene = new DashboardScene({
        title: 'hello',
        uid: 'dash-1',
        meta: {
          canEdit: true,
        },
        body: DefaultGridLayoutManager.fromVizPanels([sourcePanel, dashboardDSPanel]),
      });

      activateFullSceneTree(scene);

      // spy on runQueries
      const spyRunQueries = jest.spyOn(dashboardDSPanel.state.$data as SceneQueryRunner, 'runQueries');

      await new Promise((r) => setTimeout(r, 1));

      expect(spyRunQueries).not.toHaveBeenCalled();

      // Simulate library panel being loaded
      libPanelBehavior.setState({
        isLoaded: true,
        uid: 'fdcvggvfy2qdca',
        name: 'My Library Panel',
        _loadedPanel: undefined,
      });

      expect(spyRunQueries).toHaveBeenCalledTimes(1);
    });
  });

  describe('DashboardDS within MixedDS', () => {
    it('Should re-run query of MixedDS panel that contains a dashboardDS when source query re-runs', async () => {
      jest.spyOn(console, 'error').mockImplementation();
      const sourcePanel = new VizPanel({
        title: 'Panel A',
        pluginId: 'table',
        key: 'panel-1',
        $data: new SceneDataTransformer({
          transformations: [],
          $data: new SceneQueryRunner({
            datasource: { uid: 'grafana' },
            queries: [{ refId: 'A', queryType: 'randomWalk' }],
          }),
        }),
      });

      const dashboardDSPanel = new VizPanel({
        title: 'Panel B',
        pluginId: 'table',
        key: 'panel-2',
        $data: new SceneDataTransformer({
          transformations: [],
          $data: new SceneQueryRunner({
            datasource: { uid: MIXED_DATASOURCE_NAME },
            queries: [
              {
                datasource: { uid: SHARED_DASHBOARD_QUERY },
                refId: 'B',
                panelId: 1,
              },
            ],
            $behaviors: [new DashboardDatasourceBehaviour({})],
          }),
        }),
      });

      const scene = new DashboardScene({
        title: 'hello',
        uid: 'dash-1',
        meta: {
          canEdit: true,
        },
        body: DefaultGridLayoutManager.fromVizPanels([sourcePanel, dashboardDSPanel]),
      });

      const sceneDeactivate = activateFullSceneTree(scene);

      await new Promise((r) => setTimeout(r, 1));

      // spy on runQueries that will be called by the behaviour
      const spy = jest
        .spyOn(dashboardDSPanel.state.$data!.state.$data as SceneQueryRunner, 'runQueries')
        .mockImplementation();

      // deactivate scene to mimic going into panel edit
      sceneDeactivate();
      // run source panel queries and update request ID
      (sourcePanel.state.$data!.state.$data as SceneQueryRunner).runQueries();

      await new Promise((r) => setTimeout(r, 1));

      // activate scene to mimic coming back from panel edit
      activateFullSceneTree(scene);

      expect(spy).toHaveBeenCalled();
    });

    it('Should re-run query when ANY source panel changes with multiple dashboardDS queries', async () => {
      jest.spyOn(console, 'error').mockImplementation();

      // Create two source panels
      const sourcePanel1 = new VizPanel({
        title: 'Panel A',
        pluginId: 'table',
        key: 'panel-1',
        $data: new SceneDataTransformer({
          transformations: [],
          $data: new SceneQueryRunner({
            datasource: { uid: 'grafana' },
            queries: [{ refId: 'A', queryType: 'randomWalk' }],
          }),
        }),
      });

      const sourcePanel2 = new VizPanel({
        title: 'Panel B',
        pluginId: 'table',
        key: 'panel-2',
        $data: new SceneDataTransformer({
          transformations: [],
          $data: new SceneQueryRunner({
            datasource: { uid: 'grafana' },
            queries: [{ refId: 'A', queryType: 'randomWalk' }],
          }),
        }),
      });

      // Create a mixed DS panel that references BOTH source panels
      const mixedDSPanel = new VizPanel({
        title: 'Panel C - Mixed',
        pluginId: 'table',
        key: 'panel-3',
        $data: new SceneDataTransformer({
          transformations: [],
          $data: new SceneQueryRunner({
            datasource: { uid: MIXED_DATASOURCE_NAME },
            queries: [
              {
                datasource: { uid: SHARED_DASHBOARD_QUERY },
                refId: 'A',
                panelId: 1,
              },
              {
                datasource: { uid: SHARED_DASHBOARD_QUERY },
                refId: 'B',
                panelId: 2,
              },
            ],
            $behaviors: [new DashboardDatasourceBehaviour({})],
          }),
        }),
      });

      const scene = new DashboardScene({
        title: 'hello',
        uid: 'dash-1',
        meta: {
          canEdit: true,
        },
        body: DefaultGridLayoutManager.fromVizPanels([sourcePanel1, sourcePanel2, mixedDSPanel]),
      });

      const sceneDeactivate = activateFullSceneTree(scene);

      await new Promise((r) => setTimeout(r, 1));

      const spy = jest
        .spyOn(mixedDSPanel.state.$data!.state.$data as SceneQueryRunner, 'runQueries')
        .mockImplementation();

      // deactivate scene
      sceneDeactivate();

      // Only change the SECOND source panel
      (sourcePanel2.state.$data!.state.$data as SceneQueryRunner).runQueries();

      await new Promise((r) => setTimeout(r, 1));

      // activate scene again
      activateFullSceneTree(scene);

      // Should re-run because the second panel changed
      expect(spy).toHaveBeenCalled();
    });

    it('Should track multiple dashboardDS queries independently', async () => {
      jest.spyOn(console, 'error').mockImplementation();

      const sourcePanel1 = new VizPanel({
        title: 'Panel A',
        pluginId: 'table',
        key: 'panel-1',
        $data: new SceneDataTransformer({
          transformations: [],
          $data: new SceneQueryRunner({
            datasource: { uid: 'grafana' },
            queries: [{ refId: 'A', queryType: 'randomWalk' }],
          }),
        }),
      });

      const sourcePanel2 = new VizPanel({
        title: 'Panel B',
        pluginId: 'table',
        key: 'panel-2',
        $data: new SceneDataTransformer({
          transformations: [],
          $data: new SceneQueryRunner({
            datasource: { uid: 'grafana' },
            queries: [{ refId: 'A', queryType: 'randomWalk' }],
          }),
        }),
      });

      const mixedDSPanel = new VizPanel({
        title: 'Panel C - Mixed',
        pluginId: 'table',
        key: 'panel-3',
        $data: new SceneDataTransformer({
          transformations: [],
          $data: new SceneQueryRunner({
            datasource: { uid: MIXED_DATASOURCE_NAME },
            queries: [
              {
                datasource: { uid: SHARED_DASHBOARD_QUERY },
                refId: 'A',
                panelId: 1,
              },
              {
                datasource: { uid: SHARED_DASHBOARD_QUERY },
                refId: 'B',
                panelId: 2,
              },
            ],
            $behaviors: [new DashboardDatasourceBehaviour({})],
          }),
        }),
      });

      const scene = new DashboardScene({
        title: 'hello',
        uid: 'dash-1',
        meta: {
          canEdit: true,
        },
        body: DefaultGridLayoutManager.fromVizPanels([sourcePanel1, sourcePanel2, mixedDSPanel]),
      });

      const sceneDeactivate = activateFullSceneTree(scene);

      await new Promise((r) => setTimeout(r, 1));

      const spy = jest
        .spyOn(mixedDSPanel.state.$data!.state.$data as SceneQueryRunner, 'runQueries')
        .mockImplementation();

      // First cycle: change panel 1
      sceneDeactivate();
      (sourcePanel1.state.$data!.state.$data as SceneQueryRunner).runQueries();
      await new Promise((r) => setTimeout(r, 1));
      const deactivate2 = activateFullSceneTree(scene);
      expect(spy).toHaveBeenCalledTimes(1);

      // Second cycle: change panel 2
      deactivate2();
      (sourcePanel2.state.$data!.state.$data as SceneQueryRunner).runQueries();
      await new Promise((r) => setTimeout(r, 1));
      activateFullSceneTree(scene);

      // Should have been called again for panel 2
      expect(spy).toHaveBeenCalledTimes(2);
    });

    it('Should handle multiple dashboardDS queries with library panels', async () => {
      jest.spyOn(console, 'error').mockImplementation();

      const libPanelBehavior1 = new LibraryPanelBehavior({
        isLoaded: false,
        uid: 'lib-panel-1',
        name: 'Library Panel 1',
        _loadedPanel: undefined,
      });

      const libPanelBehavior2 = new LibraryPanelBehavior({
        isLoaded: false,
        uid: 'lib-panel-2',
        name: 'Library Panel 2',
        _loadedPanel: undefined,
      });

      const sourcePanel1 = new VizPanel({
        title: 'Panel A',
        pluginId: 'table',
        key: 'panel-1',
        $behaviors: [libPanelBehavior1],
        $data: new SceneQueryRunner({
          datasource: { uid: 'grafana' },
          queries: [{ refId: 'A', queryType: 'randomWalk' }],
        }),
      });

      const sourcePanel2 = new VizPanel({
        title: 'Panel B',
        pluginId: 'table',
        key: 'panel-2',
        $behaviors: [libPanelBehavior2],
        $data: new SceneQueryRunner({
          datasource: { uid: 'grafana' },
          queries: [{ refId: 'A', queryType: 'randomWalk' }],
        }),
      });

      const mixedDSPanel = new VizPanel({
        title: 'Panel C - Mixed',
        pluginId: 'table',
        key: 'panel-3',
        $data: new SceneQueryRunner({
          datasource: { uid: MIXED_DATASOURCE_NAME },
          queries: [
            {
              datasource: { uid: SHARED_DASHBOARD_QUERY },
              refId: 'A',
              panelId: 1,
            },
            {
              datasource: { uid: SHARED_DASHBOARD_QUERY },
              refId: 'B',
              panelId: 2,
            },
          ],
          $behaviors: [new DashboardDatasourceBehaviour({})],
        }),
      });

      const scene = new DashboardScene({
        title: 'hello',
        uid: 'dash-1',
        meta: {
          canEdit: true,
        },
        body: DefaultGridLayoutManager.fromVizPanels([sourcePanel1, sourcePanel2, mixedDSPanel]),
      });

      activateFullSceneTree(scene);

      const spy = jest.spyOn(mixedDSPanel.state.$data as SceneQueryRunner, 'runQueries');

      await new Promise((r) => setTimeout(r, 1));

      // Should not run queries until library panels are loaded
      expect(spy).not.toHaveBeenCalled();

      // Load first library panel
      libPanelBehavior1.setState({
        isLoaded: true,
        uid: 'lib-panel-1',
        name: 'Library Panel 1',
        _loadedPanel: undefined,
      });

      expect(spy).toHaveBeenCalledTimes(1);

      // Load second library panel
      libPanelBehavior2.setState({
        isLoaded: true,
        uid: 'lib-panel-2',
        name: 'Library Panel 2',
        _loadedPanel: undefined,
      });

      expect(spy).toHaveBeenCalledTimes(2);
    });

    it('Should handle multiple queries with transformers on all source panels', async () => {
      jest.spyOn(console, 'error').mockImplementation();

      const sourcePanel1 = new VizPanel({
        title: 'Panel A',
        pluginId: 'table',
        key: 'panel-1',
        $data: new SceneDataTransformer({
          transformations: [{ id: 'transformA', options: {} }],
          $data: new SceneQueryRunner({
            datasource: { uid: 'grafana' },
            queries: [{ refId: 'A', queryType: 'randomWalk' }],
          }),
        }),
      });

      const sourcePanel2 = new VizPanel({
        title: 'Panel B',
        pluginId: 'table',
        key: 'panel-2',
        $data: new SceneDataTransformer({
          transformations: [{ id: 'transformB', options: {} }],
          $data: new SceneQueryRunner({
            datasource: { uid: 'grafana' },
            queries: [{ refId: 'A', queryType: 'randomWalk' }],
          }),
        }),
      });

      const mixedDSPanel = new VizPanel({
        title: 'Panel C - Mixed',
        pluginId: 'table',
        key: 'panel-3',
        $data: new SceneQueryRunner({
          datasource: { uid: MIXED_DATASOURCE_NAME },
          queries: [
            {
              datasource: { uid: SHARED_DASHBOARD_QUERY },
              refId: 'A',
              panelId: 1,
            },
            {
              datasource: { uid: SHARED_DASHBOARD_QUERY },
              refId: 'B',
              panelId: 2,
            },
          ],
          $behaviors: [new DashboardDatasourceBehaviour({})],
        }),
      });

      const scene = new DashboardScene({
        title: 'hello',
        uid: 'dash-1',
        meta: {
          canEdit: true,
        },
        body: DefaultGridLayoutManager.fromVizPanels([sourcePanel1, sourcePanel2, mixedDSPanel]),
      });

      activateFullSceneTree(scene);

      await new Promise((r) => setTimeout(r, 1));

      const spy = jest.spyOn(mixedDSPanel.state.$data as SceneQueryRunner, 'runQueries').mockImplementation();

      // Trigger transformer reprocessing on panel 1
      (sourcePanel1.state.$data as SceneDataTransformer).setState({
        data: {
          state: LoadingState.Done,
          series: [],
          timeRange: getDefaultTimeRange(),
          request: { requestId: 'new-request-id-1' } as DataQueryRequest,
        },
      });

      expect(spy).toHaveBeenCalledTimes(1);

      // Trigger transformer reprocessing on panel 2
      (sourcePanel2.state.$data as SceneDataTransformer).setState({
        data: {
          state: LoadingState.Done,
          series: [],
          timeRange: getDefaultTimeRange(),
          request: { requestId: 'new-request-id-2' } as DataQueryRequest,
        },
      });

      expect(spy).toHaveBeenCalledTimes(2);
    });
  });

  it('Should re-run query after transformations reprocess', async () => {
    // sometimes this tests fails with a console error `AggregateError` with an XMLHttpRequest component
    // this is not related to the test, but a side effect of the interaction with scenes, mixed ds or even js dom
    // considering it a flaky test, we are explicitly ignoring it by mocking console.error
    jest.spyOn(console, 'error').mockImplementation();
    const sourcePanel = new VizPanel({
      title: 'Panel A',
      pluginId: 'table',
      key: 'panel-1',
      $data: new SceneDataTransformer({
        transformations: [{ id: 'transformA', options: {} }],
        $data: new SceneQueryRunner({
          datasource: { uid: 'grafana' },
          queries: [{ refId: 'A', queryType: 'randomWalk' }],
        }),
      }),
    });

    const dashboardDSPanel = new VizPanel({
      title: 'Panel B',
      pluginId: 'table',
      key: 'panel-2',
      $data: new SceneDataTransformer({
        transformations: [],
        $data: new SceneQueryRunner({
          datasource: { uid: MIXED_DATASOURCE_NAME },
          queries: [
            {
              datasource: { uid: SHARED_DASHBOARD_QUERY },
              refId: 'B',
              panelId: 1,
            },
          ],
          $behaviors: [new DashboardDatasourceBehaviour({})],
        }),
      }),
    });

    const scene = new DashboardScene({
      title: 'hello',
      uid: 'dash-1',
      meta: {
        canEdit: true,
      },
      body: DefaultGridLayoutManager.fromVizPanels([sourcePanel, dashboardDSPanel]),
    });

    activateFullSceneTree(scene);

    await new Promise((r) => setTimeout(r, 1));

    // spy on runQueries that will be called by the behaviour
    const spy = jest
      .spyOn(dashboardDSPanel.state.$data!.state.$data as SceneQueryRunner, 'runQueries')
      .mockImplementation();

    // transformations are reprocessed (e.g. variable change) and data is updated so
    // we re-run the queries in the dashboardDS panel because we lose the subscription
    // in mixed DS scenario
    (sourcePanel.state.$data as SceneDataTransformer).setState({
      data: {
        state: LoadingState.Done,
        series: [],
        timeRange: getDefaultTimeRange(),
        request: { requestId: 'new-request-id' } as DataQueryRequest,
      },
    });

    expect(spy).toHaveBeenCalled();
  });

  describe('Cancel and streaming scenarios', () => {
    it('Should NOT re-run query when source panel is cancelled (same requestId)', async () => {
      jest.spyOn(console, 'error').mockImplementation();

      const sourcePanel = new VizPanel({
        title: 'Panel A',
        pluginId: 'table',
        key: 'panel-1',
        $data: new SceneDataTransformer({
          transformations: [{ id: 'transformA', options: {} }],
          $data: new SceneQueryRunner({
            datasource: { uid: 'grafana' },
            queries: [{ refId: 'A', queryType: 'randomWalk' }],
          }),
        }),
      });

      const dashboardDSPanel = new VizPanel({
        title: 'Panel B',
        pluginId: 'table',
        key: 'panel-2',
        $data: new SceneDataTransformer({
          transformations: [],
          $data: new SceneQueryRunner({
            datasource: { uid: MIXED_DATASOURCE_NAME },
            queries: [
              {
                datasource: { uid: SHARED_DASHBOARD_QUERY },
                refId: 'B',
                panelId: 1,
              },
            ],
            $behaviors: [new DashboardDatasourceBehaviour({})],
          }),
        }),
      });

      const scene = new DashboardScene({
        title: 'hello',
        uid: 'dash-1',
        meta: {
          canEdit: true,
        },
        body: DefaultGridLayoutManager.fromVizPanels([sourcePanel, dashboardDSPanel]),
      });

      activateFullSceneTree(scene);

      await new Promise((r) => setTimeout(r, 1));

      const spy = jest
        .spyOn(dashboardDSPanel.state.$data!.state.$data as SceneQueryRunner, 'runQueries')
        .mockImplementation();

      const sameRequestId = 'SQR100';

      // Set initial state with a requestId (simulating a running query)
      (sourcePanel.state.$data as SceneDataTransformer).setState({
        data: {
          state: LoadingState.Loading,
          series: [],
          timeRange: getDefaultTimeRange(),
          request: { requestId: sameRequestId } as DataQueryRequest,
        },
      });

      spy.mockClear();

      // Simulate cancel: state changes to Done, but requestId stays the same
      // This mimics cancelQuery() which does: { ...this.state.data, state: LoadingState.Done }
      (sourcePanel.state.$data as SceneDataTransformer).setState({
        data: {
          state: LoadingState.Done,
          series: [],
          timeRange: getDefaultTimeRange(),
          request: { requestId: sameRequestId } as DataQueryRequest,
        },
      });

      // Should NOT re-run because requestId didn't change (cancel scenario)
      expect(spy).not.toHaveBeenCalled();
    });

    it('Should re-run query when source panel has new requestId (normal completion)', async () => {
      jest.spyOn(console, 'error').mockImplementation();

      const sourcePanel = new VizPanel({
        title: 'Panel A',
        pluginId: 'table',
        key: 'panel-1',
        $data: new SceneDataTransformer({
          transformations: [{ id: 'transformA', options: {} }],
          $data: new SceneQueryRunner({
            datasource: { uid: 'grafana' },
            queries: [{ refId: 'A', queryType: 'randomWalk' }],
          }),
        }),
      });

      const dashboardDSPanel = new VizPanel({
        title: 'Panel B',
        pluginId: 'table',
        key: 'panel-2',
        $data: new SceneDataTransformer({
          transformations: [],
          $data: new SceneQueryRunner({
            datasource: { uid: MIXED_DATASOURCE_NAME },
            queries: [
              {
                datasource: { uid: SHARED_DASHBOARD_QUERY },
                refId: 'B',
                panelId: 1,
              },
            ],
            $behaviors: [new DashboardDatasourceBehaviour({})],
          }),
        }),
      });

      const scene = new DashboardScene({
        title: 'hello',
        uid: 'dash-1',
        meta: {
          canEdit: true,
        },
        body: DefaultGridLayoutManager.fromVizPanels([sourcePanel, dashboardDSPanel]),
      });

      activateFullSceneTree(scene);

      await new Promise((r) => setTimeout(r, 1));

      const spy = jest
        .spyOn(dashboardDSPanel.state.$data!.state.$data as SceneQueryRunner, 'runQueries')
        .mockImplementation();

      // Set initial state with first requestId
      (sourcePanel.state.$data as SceneDataTransformer).setState({
        data: {
          state: LoadingState.Done,
          series: [],
          timeRange: getDefaultTimeRange(),
          request: { requestId: 'SQR100' } as DataQueryRequest,
        },
      });

      spy.mockClear();

      // New query completes with different requestId
      (sourcePanel.state.$data as SceneDataTransformer).setState({
        data: {
          state: LoadingState.Done,
          series: [],
          timeRange: getDefaultTimeRange(),
          request: { requestId: 'SQR101' } as DataQueryRequest,
        },
      });

      // Should re-run because requestId changed
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('Should re-run query during streaming (same requestId but streaming state)', async () => {
      jest.spyOn(console, 'error').mockImplementation();

      const sourcePanel = new VizPanel({
        title: 'Panel A',
        pluginId: 'table',
        key: 'panel-1',
        $data: new SceneDataTransformer({
          transformations: [{ id: 'transformA', options: {} }],
          $data: new SceneQueryRunner({
            datasource: { uid: 'grafana' },
            queries: [{ refId: 'A', queryType: 'randomWalk' }],
          }),
        }),
      });

      const dashboardDSPanel = new VizPanel({
        title: 'Panel B',
        pluginId: 'table',
        key: 'panel-2',
        $data: new SceneDataTransformer({
          transformations: [],
          $data: new SceneQueryRunner({
            datasource: { uid: MIXED_DATASOURCE_NAME },
            queries: [
              {
                datasource: { uid: SHARED_DASHBOARD_QUERY },
                refId: 'B',
                panelId: 1,
              },
            ],
            $behaviors: [new DashboardDatasourceBehaviour({})],
          }),
        }),
      });

      const scene = new DashboardScene({
        title: 'hello',
        uid: 'dash-1',
        meta: {
          canEdit: true,
        },
        body: DefaultGridLayoutManager.fromVizPanels([sourcePanel, dashboardDSPanel]),
      });

      activateFullSceneTree(scene);

      await new Promise((r) => setTimeout(r, 1));

      const spy = jest
        .spyOn(dashboardDSPanel.state.$data!.state.$data as SceneQueryRunner, 'runQueries')
        .mockImplementation();

      const streamingRequestId = 'SQR100';

      // Set initial streaming state
      (sourcePanel.state.$data as SceneDataTransformer).setState({
        data: {
          state: LoadingState.Streaming,
          series: [{ fields: [], length: 10 }],
          timeRange: getDefaultTimeRange(),
          request: { requestId: streamingRequestId } as DataQueryRequest,
        },
      });

      spy.mockClear();

      // Streaming data update (same requestId, still Streaming)
      (sourcePanel.state.$data as SceneDataTransformer).setState({
        data: {
          state: LoadingState.Streaming,
          series: [{ fields: [], length: 20 }],
          timeRange: getDefaultTimeRange(),
          request: { requestId: streamingRequestId } as DataQueryRequest,
        },
      });

      // Should re-run because isStreaming is true
      expect(spy).toHaveBeenCalledTimes(1);
    });
  });

  describe('Chained dashboard datasource', () => {
    // A "chained" dashboard datasource is a dashboard-DS panel whose source is itself
    // a dashboard-DS panel. The intermediate forwards fresh upstream data on its
    // already-open subscription without re-running, so its requestId stays constant
    // across the stale -> fresh change. The consumer must still re-run (unlike a
    // cancel, which keeps the same requestId but brings no new data).
    it('Should re-run consumer when a source panel emits new Done data under the same requestId', async () => {
      jest.spyOn(console, 'error').mockImplementation();

      // Intermediate panel: a dashboard-DS panel pointing at a deeper query panel.
      const sourcePanel = new VizPanel({
        title: 'Intermediate dashboard-DS panel',
        pluginId: 'table',
        key: 'panel-1',
        $data: new SceneDataTransformer({
          transformations: [{ id: 'transformA', options: {} }],
          $data: new SceneQueryRunner({
            datasource: { uid: SHARED_DASHBOARD_QUERY },
            queries: [{ refId: 'A', panelId: 44 }],
            $behaviors: [new DashboardDatasourceBehaviour({})],
          }),
        }),
      });

      // Consumer panel: reads the intermediate panel via dashboard DS.
      const dashboardDSPanel = new VizPanel({
        title: 'Consumer panel',
        pluginId: 'table',
        key: 'panel-2',
        $data: new SceneDataTransformer({
          transformations: [],
          $data: new SceneQueryRunner({
            datasource: { uid: MIXED_DATASOURCE_NAME },
            queries: [
              {
                datasource: { uid: SHARED_DASHBOARD_QUERY },
                refId: 'B',
                panelId: 1,
              },
            ],
            $behaviors: [new DashboardDatasourceBehaviour({})],
          }),
        }),
      });

      const scene = new DashboardScene({
        title: 'hello',
        uid: 'dash-1',
        meta: {
          canEdit: true,
        },
        body: DefaultGridLayoutManager.fromVizPanels([sourcePanel, dashboardDSPanel]),
      });

      activateFullSceneTree(scene);

      await new Promise((r) => setTimeout(r, 1));

      const spy = jest
        .spyOn(dashboardDSPanel.state.$data!.state.$data as SceneQueryRunner, 'runQueries')
        .mockImplementation();

      const sameRequestId = 'SQR100';

      // The intermediate forwards a STALE Done from its upstream.
      (sourcePanel.state.$data as SceneDataTransformer).setState({
        data: {
          state: LoadingState.Done,
          series: [{ fields: [], length: 10 }],
          timeRange: getDefaultTimeRange(),
          request: { requestId: sameRequestId } as DataQueryRequest,
        },
      });

      spy.mockClear();

      // The intermediate's upstream finishes; the intermediate forwards FRESH data
      // on its still-open subscription. It did NOT re-run, so the requestId is
      // unchanged, but the series content is different and the state is still Done.
      (sourcePanel.state.$data as SceneDataTransformer).setState({
        data: {
          state: LoadingState.Done,
          series: [{ fields: [], length: 20 }],
          timeRange: getDefaultTimeRange(),
          request: { requestId: sameRequestId } as DataQueryRequest,
        },
      });

      // The consumer must re-run to pick up the fresh forwarded data. The chained
      // re-run is coalesced on a trailing window, so wait for it to fire.
      await new Promise((r) => setTimeout(r, 150));
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('Should coalesce a burst of forwarded Done updates into a single consumer re-run', async () => {
      jest.spyOn(console, 'error').mockImplementation();

      const sourcePanel = new VizPanel({
        title: 'Intermediate dashboard-DS panel',
        pluginId: 'table',
        key: 'panel-1',
        $data: new SceneDataTransformer({
          transformations: [{ id: 'transformA', options: {} }],
          $data: new SceneQueryRunner({
            datasource: { uid: SHARED_DASHBOARD_QUERY },
            queries: [{ refId: 'A', panelId: 44 }],
            $behaviors: [new DashboardDatasourceBehaviour({})],
          }),
        }),
      });

      const dashboardDSPanel = new VizPanel({
        title: 'Consumer panel',
        pluginId: 'table',
        key: 'panel-2',
        $data: new SceneDataTransformer({
          transformations: [],
          $data: new SceneQueryRunner({
            datasource: { uid: MIXED_DATASOURCE_NAME },
            queries: [{ datasource: { uid: SHARED_DASHBOARD_QUERY }, refId: 'B', panelId: 1 }],
            $behaviors: [new DashboardDatasourceBehaviour({})],
          }),
        }),
      });

      const scene = new DashboardScene({
        title: 'hello',
        uid: 'dash-1',
        meta: { canEdit: true },
        body: DefaultGridLayoutManager.fromVizPanels([sourcePanel, dashboardDSPanel]),
      });

      activateFullSceneTree(scene);
      await new Promise((r) => setTimeout(r, 1));

      const spy = jest
        .spyOn(dashboardDSPanel.state.$data!.state.$data as SceneQueryRunner, 'runQueries')
        .mockImplementation();

      const sameRequestId = 'SQR100';
      const t = sourcePanel.state.$data as SceneDataTransformer;

      // First (stale) Done, then a rapid burst of forwarded Done updates under the
      // SAME requestId (as a slow chained upstream progressively forwards).
      t.setState({
        data: {
          state: LoadingState.Done,
          series: [{ fields: [], length: 0 }],
          timeRange: getDefaultTimeRange(),
          request: { requestId: sameRequestId } as DataQueryRequest,
        },
      });
      spy.mockClear();

      for (let i = 1; i <= 4; i++) {
        t.setState({
          data: {
            state: LoadingState.Done,
            series: [{ fields: [], length: i * 10 }],
            timeRange: getDefaultTimeRange(),
            request: { requestId: sameRequestId } as DataQueryRequest,
          },
        });
      }

      // Not run synchronously — coalesced on the trailing window.
      expect(spy).not.toHaveBeenCalled();

      // After the window, exactly ONE re-run fires (not one per forward).
      await new Promise((r) => setTimeout(r, 150));
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('Should cancel a pending coalesced re-run when a normal completion arrives', async () => {
      jest.spyOn(console, 'error').mockImplementation();

      const sourcePanel = new VizPanel({
        title: 'Intermediate dashboard-DS panel',
        pluginId: 'table',
        key: 'panel-1',
        $data: new SceneDataTransformer({
          transformations: [{ id: 'transformA', options: {} }],
          $data: new SceneQueryRunner({
            datasource: { uid: SHARED_DASHBOARD_QUERY },
            queries: [{ refId: 'A', panelId: 44 }],
            $behaviors: [new DashboardDatasourceBehaviour({})],
          }),
        }),
      });

      const dashboardDSPanel = new VizPanel({
        title: 'Consumer panel',
        pluginId: 'table',
        key: 'panel-2',
        $data: new SceneDataTransformer({
          transformations: [],
          $data: new SceneQueryRunner({
            datasource: { uid: MIXED_DATASOURCE_NAME },
            queries: [{ datasource: { uid: SHARED_DASHBOARD_QUERY }, refId: 'B', panelId: 1 }],
            $behaviors: [new DashboardDatasourceBehaviour({})],
          }),
        }),
      });

      const scene = new DashboardScene({
        title: 'hello',
        uid: 'dash-1',
        meta: { canEdit: true },
        body: DefaultGridLayoutManager.fromVizPanels([sourcePanel, dashboardDSPanel]),
      });

      activateFullSceneTree(scene);
      await new Promise((r) => setTimeout(r, 1));

      const spy = jest
        .spyOn(dashboardDSPanel.state.$data!.state.$data as SceneQueryRunner, 'runQueries')
        .mockImplementation();

      const sameRequestId = 'SQR100';
      const t = sourcePanel.state.$data as SceneDataTransformer;

      t.setState({
        data: {
          state: LoadingState.Done,
          series: [{ fields: [], length: 10 }],
          timeRange: getDefaultTimeRange(),
          request: { requestId: sameRequestId } as DataQueryRequest,
        },
      });
      spy.mockClear();

      // Chained forward under the same requestId — schedules the coalesce timer.
      t.setState({
        data: {
          state: LoadingState.Done,
          series: [{ fields: [], length: 20 }],
          timeRange: getDefaultTimeRange(),
          request: { requestId: sameRequestId } as DataQueryRequest,
        },
      });
      expect(spy).not.toHaveBeenCalled();

      // Genuine new completion within the coalesce window — must run immediately
      // and cancel the pending coalesced re-run.
      t.setState({
        data: {
          state: LoadingState.Done,
          series: [{ fields: [], length: 30 }],
          timeRange: getDefaultTimeRange(),
          request: { requestId: 'SQR101' } as DataQueryRequest,
        },
      });
      expect(spy).toHaveBeenCalledTimes(1);

      // The stale coalesce timer must not fire a second re-run.
      await new Promise((r) => setTimeout(r, 150));
      expect(spy).toHaveBeenCalledTimes(1);
    });

    // With no transformations the intermediate runs through the #118629 branch that
    // subscribes to the source's SceneQueryRunner directly. The two tests below cover
    // re-running on a fresh Done under the same requestId, and the #116767 cancel guard.
    it('Should re-run consumer when a no-transformations source emits new Done data under the same requestId', async () => {
      jest.spyOn(console, 'error').mockImplementation();

      const sourcePanel = new VizPanel({
        title: 'Intermediate dashboard-DS panel (no transformations)',
        pluginId: 'table',
        key: 'panel-1',
        $data: new SceneDataTransformer({
          transformations: [],
          $data: new SceneQueryRunner({
            datasource: { uid: SHARED_DASHBOARD_QUERY },
            queries: [{ refId: 'A', panelId: 44 }],
            $behaviors: [new DashboardDatasourceBehaviour({})],
          }),
        }),
      });

      const dashboardDSPanel = new VizPanel({
        title: 'Consumer panel',
        pluginId: 'table',
        key: 'panel-2',
        $data: new SceneDataTransformer({
          transformations: [],
          $data: new SceneQueryRunner({
            datasource: { uid: MIXED_DATASOURCE_NAME },
            queries: [
              {
                datasource: { uid: SHARED_DASHBOARD_QUERY },
                refId: 'B',
                panelId: 1,
              },
            ],
            $behaviors: [new DashboardDatasourceBehaviour({})],
          }),
        }),
      });

      const scene = new DashboardScene({
        title: 'hello',
        uid: 'dash-1',
        meta: {
          canEdit: true,
        },
        body: DefaultGridLayoutManager.fromVizPanels([sourcePanel, dashboardDSPanel]),
      });

      activateFullSceneTree(scene);

      await new Promise((r) => setTimeout(r, 1));

      const spy = jest
        .spyOn(dashboardDSPanel.state.$data!.state.$data as SceneQueryRunner, 'runQueries')
        .mockImplementation();

      const sameRequestId = 'SQR100';

      // The no-transformations branch subscribes to the source's inner query
      // runner, so drive state there.
      const sourceRunner = sourcePanel.state.$data!.state.$data as SceneQueryRunner;

      // Stale Done forwarded by the intermediate.
      sourceRunner.setState({
        data: {
          state: LoadingState.Done,
          series: [{ fields: [], length: 10 }],
          timeRange: getDefaultTimeRange(),
          request: { requestId: sameRequestId } as DataQueryRequest,
        },
      });

      spy.mockClear();

      // Fresh Done forwarded on the still-open subscription: same requestId, new content.
      sourceRunner.setState({
        data: {
          state: LoadingState.Done,
          series: [{ fields: [], length: 20 }],
          timeRange: getDefaultTimeRange(),
          request: { requestId: sameRequestId } as DataQueryRequest,
        },
      });

      // The consumer must re-run to pick up the fresh forwarded data (coalesced,
      // trailing), so wait for the window before asserting.
      await new Promise((r) => setTimeout(r, 150));
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('Should NOT re-run consumer on cancel when the source panel has no transformations', async () => {
      jest.spyOn(console, 'error').mockImplementation();

      const sourcePanel = new VizPanel({
        title: 'Source panel (no transformations)',
        pluginId: 'table',
        key: 'panel-1',
        $data: new SceneDataTransformer({
          transformations: [],
          $data: new SceneQueryRunner({
            datasource: { uid: SHARED_DASHBOARD_QUERY },
            queries: [{ refId: 'A', panelId: 44 }],
            $behaviors: [new DashboardDatasourceBehaviour({})],
          }),
        }),
      });

      const dashboardDSPanel = new VizPanel({
        title: 'Consumer panel',
        pluginId: 'table',
        key: 'panel-2',
        $data: new SceneDataTransformer({
          transformations: [],
          $data: new SceneQueryRunner({
            datasource: { uid: MIXED_DATASOURCE_NAME },
            queries: [
              {
                datasource: { uid: SHARED_DASHBOARD_QUERY },
                refId: 'B',
                panelId: 1,
              },
            ],
            $behaviors: [new DashboardDatasourceBehaviour({})],
          }),
        }),
      });

      const scene = new DashboardScene({
        title: 'hello',
        uid: 'dash-1',
        meta: {
          canEdit: true,
        },
        body: DefaultGridLayoutManager.fromVizPanels([sourcePanel, dashboardDSPanel]),
      });

      activateFullSceneTree(scene);

      await new Promise((r) => setTimeout(r, 1));

      const spy = jest
        .spyOn(dashboardDSPanel.state.$data!.state.$data as SceneQueryRunner, 'runQueries')
        .mockImplementation();

      const sameRequestId = 'SQR100';
      const sourceRunner = sourcePanel.state.$data!.state.$data as SceneQueryRunner;

      // Query in flight.
      sourceRunner.setState({
        data: {
          state: LoadingState.Loading,
          series: [],
          timeRange: getDefaultTimeRange(),
          request: { requestId: sameRequestId } as DataQueryRequest,
        },
      });

      spy.mockClear();

      // Cancel: state flips to Done with the same requestId and no new data.
      sourceRunner.setState({
        data: {
          state: LoadingState.Done,
          series: [],
          timeRange: getDefaultTimeRange(),
          request: { requestId: sameRequestId } as DataQueryRequest,
        },
      });

      // Must NOT re-run on cancel (regression guard for #116767 on the #118629
      // branch) — not synchronously, and not via a coalesced trailing re-run.
      await new Promise((r) => setTimeout(r, 150));
      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe('panel refresh policies', () => {
    const originalFeatureToggle = config.featureToggles.panelRefreshOverride;

    beforeEach(() => {
      jest.useFakeTimers();
      config.featureToggles.panelRefreshOverride = true;
      jest.spyOn(SceneQueryRunner.prototype, 'runQueries').mockImplementation();
    });

    afterEach(() => {
      jest.useRealTimers();
      jest.restoreAllMocks();
      config.featureToggles.panelRefreshOverride = originalFeatureToggle;
    });

    it.each([
      ['inherited source dashboard work', undefined, RefreshOrigin.Dashboard, undefined, true],
      ['interval source panel work', '5s', RefreshOrigin.Panel, undefined, true],
      ['Off source global work', 'off', RefreshOrigin.Global, undefined, true],
      ['dashboard work for an interval dependent', undefined, RefreshOrigin.Dashboard, '5s', false],
      ['panel work for an interval dependent', '5s', RefreshOrigin.Panel, '5s', false],
      ['global work for an interval dependent', 'off', RefreshOrigin.Global, '5s', true],
      ['dashboard work for an Off dependent', undefined, RefreshOrigin.Dashboard, 'off', false],
      ['global work for an Off dependent', 'off', RefreshOrigin.Global, 'off', true],
    ])('filters %s', (_name, sourceRefresh, sourceOrigin, dependentRefresh, shouldRun) => {
      const context = buildPolicyTestScene(sourceRefresh, dependentRefresh);
      const origins: Array<RefreshOrigin | undefined> = [];
      const runQueries = jest
        .spyOn(context.dependentRunner, 'runQueries')
        .mockImplementation(() => origins.push(getRefreshOrigin()));
      const deadline = getPanelRefreshFor(context.dependentPanel)?.['timeout'];

      publishSourceRequest(context.sourceRunner, sourceOrigin, 'source-request');

      expect(runQueries).toHaveBeenCalledTimes(shouldRun ? 1 : 0);
      expect(origins).toEqual(shouldRun ? [sourceOrigin] : []);
      if (!shouldRun && dependentRefresh === '5s') {
        expect(getPanelRefreshFor(context.dependentPanel)?.['timeout']).toBe(deadline);
      }
    });

    it('uses a completed transformed source lifecycle to filter and propagate its origin', () => {
      const context = buildPolicyTestScene(undefined, '5s', true);
      const origins: Array<RefreshOrigin | undefined> = [];
      const runQueries = jest
        .spyOn(context.dependentRunner, 'runQueries')
        .mockImplementation(() => origins.push(getRefreshOrigin()));
      const deadline = getPanelRefreshFor(context.dependentPanel)?.['timeout'];

      publishSourceRequest(context.sourceRunner, RefreshOrigin.Dashboard, 'automatic-request');
      runQueries.mockClear();
      context.sourceTransformer.setState({ data: panelDataFor('automatic-request', 10) });
      jest.advanceTimersByTime(CHAINED_FORWARD_RERUN_COALESCE_TEST_MS);

      expect(runQueries).not.toHaveBeenCalled();
      expect(getPanelRefreshFor(context.dependentPanel)?.['timeout']).toBe(deadline);

      publishSourceRequest(context.sourceRunner, RefreshOrigin.Global, 'global-request');
      runQueries.mockClear();
      origins.length = 0;
      context.sourceTransformer.setState({ data: panelDataFor('global-request', 20) });
      jest.advanceTimersByTime(CHAINED_FORWARD_RERUN_COALESCE_TEST_MS);

      expect(runQueries).toHaveBeenCalledTimes(1);
      expect(origins).toEqual([RefreshOrigin.Global]);
    });

    it('does not treat unmatched Dashboard runner data as global source work', () => {
      const context = buildPolicyTestScene(undefined, '5s');
      const runQueries = jest.spyOn(context.dependentRunner, 'runQueries').mockImplementation();
      const deadline = getPanelRefreshFor(context.dependentPanel)?.['timeout'];

      context.sourceRunner.setState({ data: panelDataFor('unmatched-request', 10) });

      expect(runQueries).not.toHaveBeenCalled();
      expect(getPanelRefreshFor(context.dependentPanel)?.['timeout']).toBe(deadline);
    });

    it('propagates the recorded global origin when an older concurrent source request completes', () => {
      const context = buildPolicyTestScene(undefined, 'off');
      const origins: Array<RefreshOrigin | undefined> = [];
      const runQueries = jest
        .spyOn(context.dependentRunner, 'runQueries')
        .mockImplementation(() => origins.push(getRefreshOrigin()));

      runWithRefreshOrigin(RefreshOrigin.Global, () => context.sourceRunner.runQueries());
      context.sourceRunner.setState({ data: panelDataFor('global-request', 0, LoadingState.Loading) });
      runWithRefreshOrigin(RefreshOrigin.Dashboard, () => context.sourceRunner.runQueries());
      context.sourceRunner.setState({ data: panelDataFor('dashboard-request', 0, LoadingState.Loading) });
      runQueries.mockClear();
      origins.length = 0;

      context.sourceRunner.setState({ data: panelDataFor('global-request', 10) });

      expect(runQueries).toHaveBeenCalledTimes(1);
      expect(origins).toEqual([RefreshOrigin.Global]);
    });

    it.each([
      ['allows a global setup failure after dashboard work', RefreshOrigin.Dashboard, RefreshOrigin.Global, true],
      ['suppresses a dashboard setup failure after global work', RefreshOrigin.Global, RefreshOrigin.Dashboard, false],
    ])('%s', (_name, previousOrigin, failedOrigin, shouldRun) => {
      const context = buildPolicyTestScene(undefined, 'off');
      const origins: Array<RefreshOrigin | undefined> = [];
      const runQueries = jest
        .spyOn(context.dependentRunner, 'runQueries')
        .mockImplementation(() => origins.push(getRefreshOrigin()));

      publishSourceRequest(context.sourceRunner, previousOrigin, 'retained-request');
      runQueries.mockClear();
      origins.length = 0;

      runWithRefreshOrigin(failedOrigin, () => context.sourceRunner.runQueries());
      context.sourceRunner.setState({ data: panelDataFor('retained-request', 0, LoadingState.Error) });
      jest.advanceTimersByTime(CHAINED_FORWARD_RERUN_COALESCE_TEST_MS);

      expect(runQueries).toHaveBeenCalledTimes(shouldRun ? 1 : 0);
      expect(origins).toEqual(shouldRun ? [failedOrigin] : []);
    });

    it('promotes mixed coalesced source origins to global', () => {
      const context = buildPolicyTestScene(undefined, undefined, true, 2);
      const secondSource = context.additionalSources[0];
      const origins: Array<RefreshOrigin | undefined> = [];
      const runQueries = jest
        .spyOn(context.dependentRunner, 'runQueries')
        .mockImplementation(() => origins.push(getRefreshOrigin()));

      publishSourceRequest(context.sourceRunner, RefreshOrigin.Dashboard, 'dashboard-request');
      publishSourceRequest(secondSource.runner, RefreshOrigin.Global, 'global-request');
      jest.runOnlyPendingTimers();
      runQueries.mockClear();
      origins.length = 0;

      context.sourceTransformer.setState({ data: panelDataFor('dashboard-request', 20) });
      secondSource.transformer.setState({ data: panelDataFor('global-request', 20) });

      expect(runQueries).not.toHaveBeenCalled();
      jest.advanceTimersByTime(CHAINED_FORWARD_RERUN_COALESCE_TEST_MS);
      expect(runQueries).toHaveBeenCalledTimes(1);
      expect(origins).toEqual([RefreshOrigin.Global]);
    });

    it('keeps a pending global origin when an inherited chained panel reruns immediately', () => {
      const context = buildPolicyChainTestScene();
      const finalOrigins: Array<RefreshOrigin | undefined> = [];
      const finalRunQueries = jest
        .spyOn(context.finalRunner, 'runQueries')
        .mockImplementation(() => finalOrigins.push(getRefreshOrigin()));

      publishSourceRequest(context.sourceRunner, RefreshOrigin.Global, 'global-request');
      context.intermediateRunner.cancelQuery();
      finalRunQueries.mockClear();
      finalOrigins.length = 0;

      context.sourceTransformer.setState({ data: panelDataFor('global-request', 20) });
      publishSourceRequest(context.sourceRunner, RefreshOrigin.Dashboard, 'dashboard-request');

      expect(context.intermediateRunner.getPendingLifecycle()).toMatchObject({ origin: RefreshOrigin.Global });

      context.intermediateRunner.setState({
        data: panelDataFor('intermediate-request', 0, LoadingState.Loading),
      });
      context.intermediateRunner.setState({ data: panelDataFor('intermediate-request', 10) });

      expect(finalRunQueries).toHaveBeenCalledTimes(1);
      expect(finalOrigins).toEqual([RefreshOrigin.Global]);
      jest.advanceTimersByTime(CHAINED_FORWARD_RERUN_COALESCE_TEST_MS);
      expect(finalRunQueries).toHaveBeenCalledTimes(1);
    });

    it.each([
      [RefreshOrigin.Dashboard, false],
      [RefreshOrigin.Global, true],
    ])('filters %s source work completed while the scene is inactive', (origin, shouldRun) => {
      const context = buildPolicyTestScene(undefined, 'off');
      publishSourceRequest(context.sourceRunner, RefreshOrigin.Global, 'initial-request');
      const origins: Array<RefreshOrigin | undefined> = [];
      const runQueries = jest
        .spyOn(context.dependentRunner, 'runQueries')
        .mockImplementation(() => origins.push(getRefreshOrigin()));
      runQueries.mockClear();
      origins.length = 0;

      context.deactivate();
      runWithRefreshOrigin(origin, () => context.sourceRunner.runQueries());
      const lifecycle = Reflect.get(context.sourceRunner, 'pendingLifecycle');
      lifecycle.requestId = 'inactive-request';
      context.sourceRunner.setState({ data: panelDataFor('inactive-request', 0, LoadingState.Loading) });
      context.sourceRunner.setState({ data: panelDataFor('inactive-request', 10) });
      expect(context.sourceRunner.getLifecycleForRequest('inactive-request')?.origin).toBe(origin);
      runQueries.mockClear();
      origins.length = 0;
      context.dependentBehavior.activate();

      expect(origins.filter((value) => value !== undefined)).toEqual(shouldRun ? [origin] : []);
    });

    it.each([
      [RefreshOrigin.Dashboard, false],
      [RefreshOrigin.Global, true],
    ])('filters %s source work when a library panel finishes loading', (origin, shouldRun) => {
      const libraryPanelBehavior = new LibraryPanelBehavior({
        isLoaded: false,
        uid: 'library-panel',
        name: 'Library panel',
        _loadedPanel: undefined,
      });
      const context = buildPolicyTestScene(undefined, 'off', false, 1, libraryPanelBehavior);
      const origins: Array<RefreshOrigin | undefined> = [];
      const runQueries = jest
        .spyOn(context.dependentRunner, 'runQueries')
        .mockImplementation(() => origins.push(getRefreshOrigin()));

      publishSourceRequest(context.sourceRunner, origin, 'library-request');
      runQueries.mockClear();
      origins.length = 0;
      libraryPanelBehavior.setState({ isLoaded: true });

      expect(runQueries).toHaveBeenCalledTimes(shouldRun ? 1 : 0);
      expect(origins).toEqual(shouldRun ? [origin] : []);
    });

    it('does not propagate a cancelled automatic source request', () => {
      const context = buildPolicyTestScene(undefined, '5s');
      context.sourceRunner.setState({ data: panelDataFor('same-request', 0, LoadingState.Loading) });
      const runQueries = jest.spyOn(context.dependentRunner, 'runQueries').mockImplementation();
      runQueries.mockClear();

      runWithRefreshOrigin(RefreshOrigin.Dashboard, () => context.sourceRunner.runQueries());
      context.sourceRunner.setState({ data: panelDataFor('same-request', 0, LoadingState.Done) });

      jest.advanceTimersByTime(CHAINED_FORWARD_RERUN_COALESCE_TEST_MS);
      expect(runQueries).not.toHaveBeenCalled();
    });
  });
});

const CHAINED_FORWARD_RERUN_COALESCE_TEST_MS = 100;

function buildPolicyTestScene(
  sourceRefresh?: string,
  dependentRefresh?: string,
  transformed = false,
  sourceCount = 1,
  libraryPanelBehavior?: LibraryPanelBehavior
) {
  const sources = Array.from({ length: sourceCount }, (_, index) => {
    const runner = new DashboardSceneQueryRunner({
      datasource: { uid: 'grafana' },
      queries: [{ refId: 'A' }],
      runQueriesMode: 'manual',
    });
    const transformer = new SceneDataTransformer({
      transformations: transformed ? [{ id: 'transformA', options: {} }] : [],
      $data: runner,
    });
    const panel = new VizPanel({
      title: `Source ${index + 1}`,
      pluginId: 'table',
      key: `panel-${index + 1}`,
      $data: transformer,
      $behaviors: index === 0 && libraryPanelBehavior ? [libraryPanelBehavior] : [],
    });
    setPanelRefreshFor(panel, sourceRefresh);
    return { panel, runner, transformer };
  });

  const dependentBehavior = new DashboardDatasourceBehaviour({});
  const dependentRunner = new DashboardSceneQueryRunner({
    datasource: { uid: SHARED_DASHBOARD_QUERY },
    queries: sources.map((_, index) => ({ refId: String.fromCharCode(65 + index), panelId: index + 1 })),
    runQueriesMode: 'manual',
    $behaviors: [dependentBehavior],
  });
  const dependentPanel = new VizPanel({
    title: 'Dependent',
    pluginId: 'table',
    key: `panel-${sourceCount + 1}`,
    $data: new SceneDataTransformer({ transformations: [], $data: dependentRunner }),
  });
  setPanelRefreshFor(dependentPanel, dependentRefresh);

  const scene = new DashboardScene({
    title: 'Policy test',
    uid: 'policy-test',
    meta: { canEdit: true },
    body: DefaultGridLayoutManager.fromVizPanels([...sources.map((source) => source.panel), dependentPanel]),
  });
  const deactivate = activateFullSceneTree(scene);

  return {
    scene,
    deactivate,
    sourceRunner: sources[0].runner,
    sourceTransformer: sources[0].transformer,
    additionalSources: sources.slice(1),
    dependentPanel,
    dependentRunner,
    dependentBehavior,
  };
}

function buildPolicyChainTestScene() {
  const sourceRunner = new DashboardSceneQueryRunner({
    datasource: { uid: 'grafana' },
    queries: [{ refId: 'A' }],
    runQueriesMode: 'manual',
  });
  const sourceTransformer = new SceneDataTransformer({
    transformations: [{ id: 'transformA', options: {} }],
    $data: sourceRunner,
  });
  const sourcePanel = new VizPanel({
    title: 'Source',
    pluginId: 'table',
    key: 'panel-1',
    $data: sourceTransformer,
  });

  const intermediateRunner = new DashboardSceneQueryRunner({
    datasource: { uid: SHARED_DASHBOARD_QUERY },
    queries: [{ refId: 'A', panelId: 1 }],
    runQueriesMode: 'manual',
    $behaviors: [new DashboardDatasourceBehaviour({})],
  });
  const intermediatePanel = new VizPanel({
    title: 'Inherited intermediate',
    pluginId: 'table',
    key: 'panel-2',
    $data: new SceneDataTransformer({ transformations: [], $data: intermediateRunner }),
  });

  const finalRunner = new DashboardSceneQueryRunner({
    datasource: { uid: SHARED_DASHBOARD_QUERY },
    queries: [{ refId: 'A', panelId: 2 }],
    runQueriesMode: 'manual',
    $behaviors: [new DashboardDatasourceBehaviour({})],
  });
  const finalPanel = new VizPanel({
    title: 'Off dependent',
    pluginId: 'table',
    key: 'panel-3',
    $data: new SceneDataTransformer({ transformations: [], $data: finalRunner }),
  });
  setPanelRefreshFor(finalPanel, 'off');

  const scene = new DashboardScene({
    title: 'Policy chain test',
    uid: 'policy-chain-test',
    meta: { canEdit: true },
    body: DefaultGridLayoutManager.fromVizPanels([sourcePanel, intermediatePanel, finalPanel]),
  });
  activateFullSceneTree(scene);

  return { sourceRunner, sourceTransformer, intermediateRunner, finalRunner };
}

function publishSourceRequest(runner: DashboardSceneQueryRunner, origin: RefreshOrigin, requestId: string): void {
  runWithRefreshOrigin(origin, () => runner.runQueries());
  runner.setState({ data: panelDataFor(requestId, 0, LoadingState.Loading) });
  runner.setState({ data: panelDataFor(requestId, 10) });
}

function panelDataFor(requestId: string, length: number, state = LoadingState.Done): PanelData {
  return {
    state,
    series: [{ fields: [], length }],
    timeRange: getDefaultTimeRange(),
    request: { requestId } as DataQueryRequest,
  };
}

async function buildTestScene() {
  const sourcePanel = new VizPanel({
    title: 'Panel A',
    pluginId: 'table',
    key: 'panel-1',
    $data: new SceneDataTransformer({
      transformations: [],
      $data: new SceneQueryRunner({
        datasource: { uid: 'grafana' },
        queries: [{ refId: 'A', queryType: 'randomWalk' }],
      }),
    }),
  });

  const dashboardDSPanel = new VizPanel({
    title: 'Panel B',
    pluginId: 'table',
    key: 'panel-2',
    $data: new SceneDataTransformer({
      transformations: [],
      $data: new SceneQueryRunner({
        datasource: { uid: SHARED_DASHBOARD_QUERY },
        queries: [{ refId: 'A', panelId: 1 }],
        $behaviors: [new DashboardDatasourceBehaviour({})],
      }),
    }),
  });

  const scene = new DashboardScene({
    title: 'hello',
    uid: 'dash-1',
    meta: {
      canEdit: true,
    },
    body: DefaultGridLayoutManager.fromVizPanels([sourcePanel, dashboardDSPanel]),
  });

  const sceneDeactivate = activateFullSceneTree(scene);

  await new Promise((r) => setTimeout(r, 1));

  return { scene, sourcePanel, dashboardDSPanel, sceneDeactivate };
}
