import { t } from '@grafana/i18n';
import { config } from '@grafana/runtime';
import {
  type SceneRefreshPicker,
  type SceneComponentProps,
  sceneGraph,
  SceneObjectBase,
  type SceneObjectState,
  type SceneObjectRef,
  type VizPanel,
} from '@grafana/scenes';
import { RefreshPicker, Space, Stack, Text } from '@grafana/ui';
import { QueryInspector } from 'app/features/inspector/QueryInspector';
import { InspectTab } from 'app/features/inspector/types';

import {
  getPanelRefreshFor,
  getPanelRefreshFreshnessText,
  type PanelRefresh,
} from '../scene/panel-refresh/PanelRefresh';
import { PanelRefreshPolicy } from '../scene/panel-refresh/policy';
import { dashboardSceneGraph } from '../utils/dashboardSceneGraph';
import { getDashboardSceneFor, getQueryRunnerFor } from '../utils/utils';

export interface InspectQueryTabState extends SceneObjectState {
  panelRef: SceneObjectRef<VizPanel>;
}

export class InspectQueryTab extends SceneObjectBase<InspectQueryTabState> {
  public getTabLabel() {
    return t('dashboard.inspect.query-tab', 'Query');
  }

  public getTabValue() {
    return InspectTab.Query;
  }

  public onRefreshQuery = () => {
    const queryRunner = getQueryRunnerFor(this.state.panelRef.resolve());

    if (queryRunner) {
      queryRunner.runQueries();
    }
  };

  static Component = ({ model }: SceneComponentProps<InspectQueryTab>) => {
    const panel = model.state.panelRef.resolve();
    const data = sceneGraph.getData(panel).useState();

    if (!data.data) {
      return null;
    }

    const queryInspector = <QueryInspector data={data.data} onRefreshQuery={model.onRefreshQuery} />;
    if (!config.featureToggles.panelRefreshOverride) {
      return queryInspector;
    }

    const panelRefresh = getPanelRefreshFor(panel);
    if (!panelRefresh) {
      return queryInspector;
    }

    const dashboardRefresh = dashboardSceneGraph.getRefreshPicker(getDashboardSceneFor(panel));

    return (
      <>
        <RefreshPolicyDetails model={panelRefresh} dashboardRefresh={dashboardRefresh} />
        <Space v={2} />
        {queryInspector}
      </>
    );
  };
}

interface RefreshPolicyDetailsProps {
  model: PanelRefresh;
  dashboardRefresh?: SceneRefreshPicker;
}

function RefreshPolicyDetails({ model, dashboardRefresh }: RefreshPolicyDetailsProps) {
  const { lastUpdated, refresh } = model.useState();
  const policyText =
    model.policy === PanelRefreshPolicy.Inherit ? (
      <DashboardRefreshPolicy model={dashboardRefresh} />
    ) : model.policy === PanelRefreshPolicy.Off ? (
      t('dashboard.panel-refresh.tooltip-off', 'Automatic panel refresh is off')
    ) : (
      t('dashboard.panel-refresh.tooltip-interval', 'Panel refreshes every {{interval}}', { interval: refresh })
    );

  return (
    <Stack direction="column" gap={0.5}>
      <div>
        <Text weight="medium">{t('dashboard.inspect.query-refresh-policy-label', 'Refresh policy')}: </Text>
        <Text>{policyText}</Text>
      </div>
      <div>
        <Text weight="medium">{t('dashboard.inspect.query-freshness-label', 'Freshness')}: </Text>
        <Text>{getPanelRefreshFreshnessText(lastUpdated)}</Text>
      </div>
    </Stack>
  );
}

function DashboardRefreshPolicy({ model }: { model?: SceneRefreshPicker }) {
  if (!model) {
    return t('dashboard.inspect.query-refresh-dashboard-off', 'Automatic dashboard refresh is off');
  }

  return <DashboardRefreshPolicyValue model={model} />;
}

function DashboardRefreshPolicyValue({ model }: { model: SceneRefreshPicker }) {
  const { refresh, autoValue } = model.useState();
  if (!refresh) {
    return t('dashboard.inspect.query-refresh-dashboard-off', 'Automatic dashboard refresh is off');
  }

  const interval = refresh === RefreshPicker.autoOption.value ? autoValue : refresh;
  return interval
    ? t('dashboard.inspect.query-refresh-dashboard-interval', 'Dashboard refreshes every {{interval}}', { interval })
    : t('dashboard.inspect.query-refresh-dashboard-auto', 'Dashboard refresh interval is automatic');
}
