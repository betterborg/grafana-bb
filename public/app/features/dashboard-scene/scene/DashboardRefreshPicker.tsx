import { t } from '@grafana/i18n';
import { type SceneComponentProps, SceneRefreshPicker, sceneGraph } from '@grafana/scenes';
import { RefreshPicker } from '@grafana/ui';

import { RefreshOrigin, runWithRefreshOrigin } from './refresh-origin';

export class DashboardRefreshPicker extends SceneRefreshPicker {
  static Component = DashboardRefreshPickerRenderer;
}

// The pinned Scenes renderer cannot distinguish its button from hidden-tab catch-up calls to onRefresh.
function DashboardRefreshPickerRenderer({ model }: SceneComponentProps<SceneRefreshPicker>) {
  const { refresh, intervals, autoEnabled, autoValue, isOnCanvas, primary, withText } = model.useState();
  const isRunning = useQueryControllerState(model);
  const text =
    refresh === RefreshPicker.autoOption.value
      ? autoValue
      : withText
        ? t('grafana-scenes.components.scene-refresh-picker.text-refresh', 'Refresh')
        : undefined;
  const loadingText = withText ? t('grafana-scenes.components.scene-refresh-picker.text-cancel', 'Cancel') : undefined;
  const tooltip = isRunning
    ? t('grafana-scenes.components.scene-refresh-picker.tooltip-cancel', 'Cancel all queries')
    : undefined;

  return (
    <RefreshPicker
      showAutoInterval={autoEnabled}
      value={refresh}
      intervals={intervals}
      tooltip={tooltip}
      text={text}
      loadingText={loadingText}
      onRefresh={() => runWithRefreshOrigin(RefreshOrigin.Global, model.onRefresh)}
      primary={primary}
      onIntervalChanged={model.onIntervalChanged}
      isLoading={isRunning}
      isOnCanvas={isOnCanvas ?? true}
    />
  );
}

function useQueryControllerState(model: SceneRefreshPicker): boolean {
  const queryController = sceneGraph.getQueryController(model);
  if (!queryController) {
    return false;
  }

  return queryController.useState().isRunning;
}
