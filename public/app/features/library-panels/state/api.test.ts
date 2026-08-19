import { of } from 'rxjs';

import { VizPanel } from '@grafana/scenes';
import { LibraryPanelBehavior } from 'app/features/dashboard-scene/scene/LibraryPanelBehavior';
import { AutoGridItem } from 'app/features/dashboard-scene/scene/layout-auto-grid/AutoGridItem';
import { setPanelRefreshFor } from 'app/features/dashboard-scene/scene/panel-refresh/PanelRefresh';
import { vizPanelToPanel } from 'app/features/dashboard-scene/serialization/transformSceneToSaveModel';

import { LibraryElementKind } from '../types';

import { addLibraryPanel, getLibraryPanel, libraryVizPanelToSaveModel } from './api';

const mockPost = jest.fn().mockResolvedValue({ result: {} });
const mockFetch = jest.fn();
jest.mock('../../../core/services/backend_srv', () => ({
  getBackendSrv: () => ({ fetch: mockFetch, post: mockPost }),
}));

describe('addLibraryPanel', () => {
  beforeEach(() => {
    mockPost.mockClear();
  });

  const panelSaveModel = {
    libraryPanel: { name: 'My Panel', uid: 'original-uid' },
    type: 'timeseries',
    refresh: '30s',
  };

  it('passes uid to the API when provided', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await addLibraryPanel(panelSaveModel as any, 'folder-uid', 'original-uid');

    expect(mockPost).toHaveBeenCalledWith('/api/library-elements', {
      folderUid: 'folder-uid',
      name: 'My Panel',
      model: panelSaveModel,
      kind: LibraryElementKind.Panel,
      uid: 'original-uid',
    });
  });

  it('does not include uid when not provided', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await addLibraryPanel(panelSaveModel as any, 'folder-uid');

    expect(mockPost).toHaveBeenCalledWith('/api/library-elements', {
      folderUid: 'folder-uid',
      name: 'My Panel',
      model: panelSaveModel,
      kind: LibraryElementKind.Panel,
    });
  });
});

describe('getLibraryPanel', () => {
  it('preserves refresh while migrating the API model', async () => {
    mockFetch.mockReturnValue(
      of({
        data: {
          result: {
            uid: 'uid',
            name: 'My panel',
            type: 'timeseries',
            version: 1,
            model: {
              type: 'timeseries',
              title: 'My panel',
              refresh: '30s',
              fieldConfig: { defaults: {}, overrides: [] },
              options: {},
              targets: [{ refId: 'A' }],
            },
          },
        },
      })
    );

    const libraryPanel = await getLibraryPanel('uid');

    expect(libraryPanel.model.refresh).toBe('30s');
  });
});

describe('libraryVizPanelToSaveModel', () => {
  it('uses default gridPos when the parent is an AutoGridItem', () => {
    const panel = new VizPanel({ key: 'panel-1', pluginId: 'text', title: 'Title' });

    const libPanelBehavior = new LibraryPanelBehavior({
      isLoaded: true,
      uid: 'uid',
      name: 'name',
      _loadedPanel: {
        uid: 'uid',
        name: 'name',
        type: 'text',
        model: vizPanelToPanel(panel),
        version: 1,
      },
    });

    panel.setState({ $behaviors: [libPanelBehavior] });
    setPanelRefreshFor(panel, '30s');
    new AutoGridItem({ key: 'auto-grid-item-1', body: panel });

    const saveModel = libraryVizPanelToSaveModel(panel);

    expect(saveModel.model.gridPos).toEqual({ x: 0, y: 0, w: 6, h: 3 });
    expect(saveModel.model.refresh).toBe('30s');
  });
});
