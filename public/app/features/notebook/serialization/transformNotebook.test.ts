import { waitFor } from '@testing-library/react';
import { of } from 'rxjs';

// defaultDataQueryKind is not re-exported by ../types (that seam covers the notebook-specific and
// forked names); it is a shared leaf type, so it comes straight from the generated module.
import { getDefaultTimeRange, LoadingState, type PanelData } from '@grafana/data';
import { getPanelPlugin } from '@grafana/data/test';
import { config, type DataSourceSrv, setDataSourceSrv, setPluginImportUtils, setRunRequest } from '@grafana/runtime';
import { SceneQueryRunner } from '@grafana/scenes';
import { defaultDataQueryKind } from '@grafana/schema/apis/notebook/v2beta1';
import { type Resource } from 'app/features/apiserver/types';
import { DashboardSceneQueryRunner } from 'app/features/dashboard-scene/scene/DashboardSceneQueryRunner';
import { getPanelRefreshFor } from 'app/features/dashboard-scene/scene/panel-refresh/PanelRefresh';
import { PanelTimeRange } from 'app/features/dashboard-scene/scene/panel-timerange/PanelTimeRange';
import { activateFullSceneTree } from 'app/features/dashboard-scene/utils/test-utils';
import {
  getDashboardSceneFor,
  getLibraryPanelBehavior,
  getQueryRunnerFor,
} from 'app/features/dashboard-scene/utils/utils';
import * as libraryPanelsApi from 'app/features/library-panels/state/api';

import { NotebookScene } from '../scene/NotebookScene';
import { defaultSpec as defaultNotebookSpec, type NotebookElement, type Spec as NotebookSpec } from '../types';

import { transformNotebookSceneToSaveModel } from './transformNotebookSceneToSaveModel';
import { transformNotebookToScene } from './transformNotebookToScene';

setPluginImportUtils({
  importPanelPlugin: () => Promise.resolve(getPanelPlugin({})),
  getPanelPluginFromCache: () => undefined,
});

setDataSourceSrv({
  get: jest.fn().mockResolvedValue({ getRef: () => ({ uid: 'gdev-prometheus', type: 'prometheus' }) }),
} as unknown as DataSourceSrv);

const runRequestMock = jest.fn().mockReturnValue(
  of<PanelData>({
    state: LoadingState.Done,
    timeRange: getDefaultTimeRange(),
    series: [],
  })
);
setRunRequest(runRequestMock);

// The spec fixture is written in the serializer's canonical form (explicit datasource per query,
// description always present on panels, version '' etc.) so spec → scene → spec is an exact
// round-trip. This is the contract the Mutation API's GET_NOTEBOOK_SPEC depends on.
function notebookSpec(): NotebookSpec {
  const elements: Record<string, NotebookElement> = {
    intro: { kind: 'Cell', spec: { content: { kind: 'Markdown', spec: { text: '## Checkout latency spike' } } } },
    query: { kind: 'Cell', spec: { content: { kind: 'Code', spec: { language: 'promql', code: 'up == 0' } } } },
    // A LibraryPanel cell serializes down a different branch to a Panel one: vizPanelToSchemaV2 only
    // emits LibraryPanelKind when it finds the behavior buildLibraryPanelState attaches, and otherwise
    // falls through and inlines the panel. Without a library element in this fixture, a notebook cell
    // built without that behavior would silently save as a fully inlined PanelKind — the library
    // reference gone from the spec and edits to the library panel no longer propagating — and nothing
    // here would fail. `id` and `title` mirror what the deserializer puts on the VizPanel so the
    // round-trip stays exact, same as the Panel fixture. Nothing activates the cell, so the library
    // panel is never fetched and no API mock is needed.
    'saved-cpu-panel': {
      kind: 'LibraryPanel',
      spec: {
        id: 2,
        title: 'CPU usage',
        libraryPanel: { uid: 'lib-cpu-1', name: 'CPU usage' },
      },
    },
    'latency-panel': {
      kind: 'Panel',
      spec: {
        id: 1,
        title: 'p95 latency',
        description: '',
        links: [],
        data: {
          kind: 'QueryGroup',
          spec: {
            queries: [
              {
                kind: 'PanelQuery',
                spec: {
                  refId: 'A',
                  hidden: false,
                  query: {
                    kind: 'DataQuery',
                    version: defaultDataQueryKind().version,
                    group: 'prometheus',
                    // Explicit datasource: without a DSReferencesMapping the serializer writes the
                    // runtime-resolved datasource back, so only explicit refs round-trip exactly.
                    datasource: { name: 'gdev-prometheus' },
                    spec: { expr: 'histogram_quantile(0.95, http_request_duration_seconds_bucket)' },
                  },
                },
              },
            ],
            // The notebook carries the dashboard v2 transformation shape: the transform id lives in
            // `group`, and the spec has no `id`. Pinning it here is what would catch a regression to
            // the old v2beta1 wire form ({ kind: <id>, spec: { id: <id> } }), which the notebook CUE
            // schema no longer describes.
            transformations: [{ kind: 'Transformation', group: 'limit', spec: { options: { limitField: 10 } } }],
            queryOptions: {},
          },
        },
        vizConfig: {
          kind: 'VizConfig',
          group: 'timeseries',
          version: '',
          spec: {
            options: {},
            fieldConfig: { defaults: {}, overrides: [] },
          },
        },
        // Only `true` round-trips: the save path emits undefined for a non-transparent panel.
        transparent: true,
      },
    },
  };

  return {
    ...defaultNotebookSpec(),
    title: 'Checkout latency investigation',
    description: 'What happened on checkout during the deploy',
    tags: ['incident', 'checkout'],
    timeSettings: {
      from: 'now-6h',
      to: 'now',
      timezone: 'utc',
      autoRefresh: '30s',
      autoRefreshIntervals: ['5s', '30s', '1m'],
      hideTimepicker: false,
      fiscalYearStartMonth: 0,
    },
    elements,
    layout: {
      kind: 'NotebookLayout',
      spec: {
        cells: [
          {
            kind: 'NotebookLayoutItem',
            spec: { element: { kind: 'ElementReference', name: 'intro' }, source: 'assistant' },
          },
          {
            kind: 'NotebookLayoutItem',
            spec: { element: { kind: 'ElementReference', name: 'latency-panel' }, source: 'user', collapsed: false },
          },
          {
            kind: 'NotebookLayoutItem',
            spec: { element: { kind: 'ElementReference', name: 'query' }, source: 'user' },
          },
          {
            kind: 'NotebookLayoutItem',
            spec: { element: { kind: 'ElementReference', name: 'saved-cpu-panel' }, source: 'user' },
          },
        ],
      },
    },
  };
}

function notebookResource(): Resource<NotebookSpec> {
  return {
    apiVersion: 'dashboard.grafana.app/v2beta1',
    kind: 'Notebook',
    metadata: { name: 'nb-1', resourceVersion: '1', creationTimestamp: '2026-07-01T00:00:00Z' },
    spec: notebookSpec(),
  };
}

describe('transformNotebookToScene / transformNotebookSceneToSaveModel', () => {
  it('builds a NotebookScene with the document, time controls and header state', () => {
    const scene = transformNotebookToScene(notebookResource());

    expect(scene).toBeInstanceOf(NotebookScene);
    expect(scene.state.title).toBe('Checkout latency investigation');
    expect(scene.state.uid).toBe('nb-1');
    expect(scene.state.hideTimeControls).toBe(false);
    expect(scene.state.$timeRange.state.from).toBe('now-6h');
    expect(scene.state.body.state.cells).toHaveLength(4);
    // Title and tags are surfaced on the layout manager for the document header.
    expect(scene.state.body.state.title).toBe('Checkout latency investigation');
    expect(scene.state.body.state.tags).toEqual(['incident', 'checkout']);
  });

  // V2PanelSpec.subtitle is deliberately absent from the fixture: neither buildVizPanelState nor
  // vizPanelToSchemaV2 handles it, so it would not survive. Add it here once they do.
  it('round-trips cells, order, source, panel config, timeSettings and metadata', () => {
    const spec = notebookSpec();
    const previousToggle = config.featureToggles.panelRefreshOverride;

    try {
      config.featureToggles.panelRefreshOverride = true;

      const scene = transformNotebookToScene(notebookResource());
      const saveModel = transformNotebookSceneToSaveModel(scene);

      expect(saveModel).toEqual(spec);
    } finally {
      config.featureToggles.panelRefreshOverride = previousToggle;
    }
  });

  it.each([true, false])(
    'keeps the base refresh picker querying ordinary and library cells when the dashboard feature is %s',
    async (featureEnabled) => {
      const previousToggle = config.featureToggles.panelRefreshOverride;
      config.featureToggles.panelRefreshOverride = featureEnabled;
      const getLibraryPanel = jest.spyOn(libraryPanelsApi, 'getLibraryPanel').mockResolvedValue({
        uid: 'lib-cpu-1',
        name: 'CPU usage',
        type: 'timeseries',
        version: 1,
        model: {
          title: 'CPU usage',
          type: 'timeseries',
          refresh: '30s',
          options: {},
          fieldConfig: { defaults: {}, overrides: [] },
          targets: [{ refId: 'A', datasource: { uid: 'gdev-prometheus', type: 'prometheus' } }],
        },
      });
      runRequestMock.mockClear();
      const scene = transformNotebookToScene(notebookResource());
      const ordinaryPanel = scene.state.body.state.cells.find((cell) => cell.state.elementName === 'latency-panel')!
        .state.body!;
      const libraryPanel = scene.state.body.state.cells.find((cell) => cell.state.elementName === 'saved-cpu-panel')!
        .state.body!;
      const deactivate = activateFullSceneTree(scene);

      try {
        await waitFor(() => expect(getLibraryPanelBehavior(libraryPanel)?.state.isLoaded).toBe(true));
        const ordinaryRunner = getQueryRunnerFor(ordinaryPanel);
        const libraryRunner = getQueryRunnerFor(libraryPanel);

        expect(ordinaryRunner).toBeInstanceOf(SceneQueryRunner);
        expect(libraryRunner).toBeInstanceOf(SceneQueryRunner);
        expect(libraryRunner).not.toBeInstanceOf(DashboardSceneQueryRunner);
        expect(getPanelRefreshFor(ordinaryPanel)).toBeUndefined();
        expect(getPanelRefreshFor(libraryPanel)).toBeUndefined();
        expect(ordinaryPanel.state.$timeRange).not.toBeInstanceOf(PanelTimeRange);
        expect(libraryPanel.state.$timeRange).not.toBeInstanceOf(PanelTimeRange);

        ordinaryRunner?.setContainerWidth(500);
        libraryRunner?.setContainerWidth(500);
        await waitFor(() =>
          expect(new Set(runRequestMock.mock.calls.map(([, request]) => request.panelId))).toEqual(new Set([1, 2]))
        );
        runRequestMock.mockClear();
        scene.state.refreshPicker.onRefresh();

        await waitFor(() => expect(runRequestMock).toHaveBeenCalledTimes(2));
        expect(new Set(runRequestMock.mock.calls.map(([, request]) => request.panelId))).toEqual(new Set([1, 2]));
      } finally {
        deactivate();
        config.featureToggles.panelRefreshOverride = previousToggle;
        getLibraryPanel.mockRestore();
      }
    }
  );

  // The save path borrows the dashboard's vizPanelToSchemaV2, which is only safe here because both
  // optional args are omitted: a dsReferencesMapping routes it through getElementIdentifierForVizPanel
  // -> getDashboardSceneFor, which throws for a NotebookScene root. Nothing in the signature says so,
  // and the save PR is where someone would thread a mapping through to preserve datasource references.
  // Pinning both halves so adding the arg fails here rather than at runtime on notebook save.
  it('serializes panel cells without reaching for a DashboardScene root', () => {
    const scene = transformNotebookToScene(notebookResource());
    const panel = scene.state.body.state.cells.find((cell) => cell.state.body)!.state.body!;

    expect(() => getDashboardSceneFor(panel)).toThrow();
    expect(() => transformNotebookSceneToSaveModel(scene)).not.toThrow();
  });
});
