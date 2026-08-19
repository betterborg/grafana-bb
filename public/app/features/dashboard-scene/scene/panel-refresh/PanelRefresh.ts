import type { Unsubscribable } from 'rxjs';

import { LoadingState } from '@grafana/data';
import { config } from '@grafana/runtime';
import { SceneDataTransformer, SceneObjectBase, type SceneObjectState, VizPanel } from '@grafana/scenes';

import { DashboardSceneQueryRunner } from '../DashboardSceneQueryRunner';
import { RefreshOrigin, runWithRefreshOrigin } from '../refresh-origin';

import { getPanelRefreshInterval, getPanelRefreshPolicy, PanelRefreshPolicy } from './policy';

export interface PanelRefreshState extends SceneObjectState {
  refresh?: string;
  lastUpdated?: number;
}

interface PanelRefreshTimeRange {
  refreshForPanelTick(): void;
  setPanelRefreshPolicy(policy: PanelRefreshPolicy, onGlobalRefresh?: () => void): void;
}

export class PanelRefresh extends SceneObjectBase<PanelRefreshState> {
  private timeout?: ReturnType<typeof setTimeout>;
  private waitingForPending = false;
  private missedWhileHidden = false;
  private observedLifecycleId?: number;
  private runner?: DashboardSceneQueryRunner;
  private runnerSubscription?: Unsubscribable;
  private panelTimeRange?: PanelRefreshTimeRange;
  private visibilityListenerInstalled = false;

  public constructor(state: PanelRefreshState) {
    super(state);
    this.addActivationHandler(() => this.onActivate());
  }

  public get policy(): PanelRefreshPolicy {
    if (!config.featureToggles.panelRefreshOverride) {
      return PanelRefreshPolicy.Inherit;
    }

    return getPanelRefreshPolicy(this.state.refresh);
  }

  private onActivate(): (() => void) | undefined {
    const panel = this.parent;
    if (!(panel instanceof VizPanel)) {
      throw new Error('PanelRefresh must be attached to a VizPanel');
    }

    this.bindPanelState(panel);

    this._subs.add(
      this.subscribeToState((next, previous) => {
        if (next.refresh !== previous.refresh) {
          this.configurePolicy();
        }
      })
    );
    this._subs.add(
      panel.subscribeToState((next, previous) => {
        if (next.$data !== previous.$data || next.$timeRange !== previous.$timeRange) {
          this.bindPanelState(panel);
        }
      })
    );

    return () => {
      this.clearDeadline();
      this.removeVisibilityListener();
      this.panelTimeRange?.setPanelRefreshPolicy(PanelRefreshPolicy.Inherit);
      this.runner?.setPanelRefreshViewportBypass(false);
      this.runnerSubscription?.unsubscribe();
      this.runnerSubscription = undefined;
      this.runner = undefined;
      this.panelTimeRange = undefined;
      this.waitingForPending = false;
      this.missedWhileHidden = false;
      this.observedLifecycleId = undefined;
    };
  }

  private bindPanelState(panel: VizPanel): void {
    const runner = getDashboardQueryRunner(panel);
    const panelTimeRange = isPanelRefreshTimeRange(panel.state.$timeRange) ? panel.state.$timeRange : undefined;
    if (runner === this.runner && panelTimeRange === this.panelTimeRange) {
      return;
    }

    this.runner?.setPanelRefreshViewportBypass(false);
    this.runnerSubscription?.unsubscribe();
    this.runner = runner;
    this.panelTimeRange = panelTimeRange;
    this.runnerSubscription = runner?.subscribeToState((next, previous) => {
      if (next.data !== previous.data) {
        this.onRunnerDataChanged();
      }
    });
    this.updateFreshness();
    this.configurePolicy();
  }

  private configurePolicy(): void {
    const policy = this.policy;
    this.panelTimeRange?.setPanelRefreshPolicy(policy, () => this.resetDeadline());
    this.runner?.setPanelRefreshViewportBypass(policy === PanelRefreshPolicy.Interval);
    this.waitingForPending = false;
    this.missedWhileHidden = false;
    this.observedLifecycleId = undefined;
    this.clearDeadline();

    if (policy === PanelRefreshPolicy.Interval) {
      this.installVisibilityListener();
      this.observeAcceptedLifecycle();
      this.resetDeadline();
    } else {
      this.removeVisibilityListener();
    }
  }

  private onVisibilityChange = (): void => {
    if (document.visibilityState === 'visible' && this.missedWhileHidden) {
      this.missedWhileHidden = false;
      this.tryPanelRefresh();
    }
  };

  private installVisibilityListener(): void {
    if (!this.visibilityListenerInstalled) {
      document.addEventListener('visibilitychange', this.onVisibilityChange);
      this.visibilityListenerInstalled = true;
    }
  }

  private removeVisibilityListener(): void {
    if (this.visibilityListenerInstalled) {
      document.removeEventListener('visibilitychange', this.onVisibilityChange);
      this.visibilityListenerInstalled = false;
    }
  }

  private onRunnerDataChanged(): void {
    const data = this.runner?.state.data;
    if (!data) {
      return;
    }

    this.updateFreshness();

    this.observeAcceptedLifecycle();

    if (this.waitingForPending) {
      if (!this.runner?.isQueryPending()) {
        this.waitingForPending = false;
        this.tryPanelRefresh();
      } else if (data.state === LoadingState.Done || data.state === LoadingState.Error) {
        queueMicrotask(() => {
          if (this.isActive && this.waitingForPending && !this.runner?.isQueryPending()) {
            this.waitingForPending = false;
            this.tryPanelRefresh();
          }
        });
      }
    }
  }

  private updateFreshness(): void {
    const data = this.runner?.state.data;
    let lastUpdated: number | undefined;
    if (data?.state === LoadingState.Streaming) {
      lastUpdated = Date.now();
    } else if (data?.state === LoadingState.Done && data.request?.endTime) {
      lastUpdated = data.request.endTime;
    }

    if (lastUpdated !== undefined && (this.state.lastUpdated === undefined || lastUpdated > this.state.lastUpdated)) {
      this.setState({ lastUpdated });
    }
  }

  private observeAcceptedLifecycle(): void {
    if (this.policy !== PanelRefreshPolicy.Interval) {
      return;
    }

    const lifecycle = this.runner?.getPendingLifecycle();
    if (!lifecycle || lifecycle.id === this.observedLifecycleId) {
      return;
    }

    this.observedLifecycleId = lifecycle.id;
    if (lifecycle.origin === RefreshOrigin.Global || lifecycle.origin === RefreshOrigin.Panel) {
      this.resetDeadline();
    }
  }

  private resetDeadline(): void {
    const interval = getPanelRefreshInterval(this.state.refresh);
    if (!interval || this.policy !== PanelRefreshPolicy.Interval) {
      return;
    }

    this.clearDeadline();
    this.timeout = setTimeout(() => {
      this.timeout = undefined;
      this.tryPanelRefresh();
    }, interval);
  }

  private clearDeadline(): void {
    if (this.timeout !== undefined) {
      clearTimeout(this.timeout);
      this.timeout = undefined;
    }
  }

  private tryPanelRefresh(): void {
    if (!this.isActive || this.policy !== PanelRefreshPolicy.Interval) {
      return;
    }

    if (document.visibilityState !== undefined && document.visibilityState !== 'visible') {
      this.missedWhileHidden = true;
      return;
    }

    if (this.runner?.isQueryPending()) {
      this.waitingForPending = true;
      return;
    }

    if (this.panelTimeRange) {
      this.panelTimeRange.refreshForPanelTick();
    } else {
      runWithRefreshOrigin(RefreshOrigin.Panel, () => this.runner?.runQueries());
    }
    this.observeAcceptedLifecycle();
    this.resetDeadline();
  }
}

export function setPanelRefreshFor(panel: VizPanel, refresh?: string): PanelRefresh {
  let panelRefresh = getPanelRefreshFor(panel);
  if (!panelRefresh) {
    panelRefresh = new PanelRefresh({ refresh });
    panel.setState({ $behaviors: [...(panel.state.$behaviors ?? []), panelRefresh] });
  } else if (panelRefresh.state.refresh !== refresh) {
    panelRefresh.setState({ refresh });
  }

  return panelRefresh;
}

export function getPanelRefreshFor(panel: VizPanel): PanelRefresh | undefined {
  return panel.state.$behaviors?.find((behavior): behavior is PanelRefresh => behavior instanceof PanelRefresh);
}

function isPanelRefreshTimeRange(value: unknown): value is PanelRefreshTimeRange {
  return (
    typeof value === 'object' && value !== null && 'refreshForPanelTick' in value && 'setPanelRefreshPolicy' in value
  );
}

function getDashboardQueryRunner(panel: VizPanel): DashboardSceneQueryRunner | undefined {
  let dataProvider = panel.state.$data;
  while (dataProvider instanceof SceneDataTransformer) {
    dataProvider = dataProvider.state.$data;
  }

  return dataProvider instanceof DashboardSceneQueryRunner ? dataProvider : undefined;
}
