import { LoadingState } from '@grafana/data';
import { type QueryRunnerState, SceneQueryRunner } from '@grafana/scenes';

import { getRefreshOrigin, RefreshOrigin } from './refresh-origin';

export interface DashboardQueryLifecycle {
  id: number;
  origin: RefreshOrigin;
  requestId?: string;
}

interface PendingDashboardQueryLifecycle extends DashboardQueryLifecycle {
  previousRequestId?: string;
}

export class DashboardSceneQueryRunner extends SceneQueryRunner {
  private nextLifecycleId = 0;
  private pendingLifecycle?: PendingDashboardQueryLifecycle;
  private externalViewportBypass = false;
  private panelRefreshViewportBypass = false;

  public constructor(initialState: QueryRunnerState) {
    super(initialState);

    this.subscribeToState((newState, oldState) => {
      if (newState.data !== oldState.data) {
        this.handleDataStateChange(newState.data?.state, newState.data?.request?.requestId);
      }
    });
  }

  public override runQueries(): void {
    this.pendingLifecycle = {
      id: ++this.nextLifecycleId,
      origin: getRefreshOrigin() ?? RefreshOrigin.Global,
      previousRequestId: this.state.data?.request?.requestId,
    };

    try {
      super.runQueries();
    } catch (error) {
      this.pendingLifecycle = undefined;
      throw error;
    }
  }

  public override cancelQuery(): void {
    const lifecycleId = this.pendingLifecycle?.id;

    try {
      super.cancelQuery();
    } finally {
      this.clearPendingLifecycle(lifecycleId);
    }
  }

  public getPendingLifecycle(): Readonly<DashboardQueryLifecycle> | undefined {
    if (!this.pendingLifecycle) {
      return undefined;
    }

    const { id, origin, requestId } = this.pendingLifecycle;
    return { id, origin, requestId };
  }

  public isQueryPending(origin?: RefreshOrigin): boolean {
    return this.pendingLifecycle !== undefined && (origin === undefined || this.pendingLifecycle.origin === origin);
  }

  public setPanelRefreshViewportBypass(bypass: boolean): void {
    this.panelRefreshViewportBypass = bypass;
    super.bypassIsInViewChanged(this.externalViewportBypass || this.panelRefreshViewportBypass);
  }

  public override bypassIsInViewChanged(bypass: boolean): void {
    this.externalViewportBypass = bypass;
    super.bypassIsInViewChanged(this.externalViewportBypass || this.panelRefreshViewportBypass);
  }

  private handleDataStateChange(state: LoadingState | undefined, requestId: string | undefined): void {
    const lifecycle = this.pendingLifecycle;
    if (!lifecycle) {
      return;
    }

    if (requestId && requestId !== lifecycle.previousRequestId && !lifecycle.requestId) {
      lifecycle.requestId = requestId;
    }

    if (state !== LoadingState.Done && state !== LoadingState.Error) {
      return;
    }

    if (lifecycle.requestId) {
      if (requestId === lifecycle.requestId) {
        this.clearPendingLifecycle(lifecycle.id);
      }
      return;
    }

    if (!requestId) {
      this.clearPendingLifecycle(lifecycle.id);
    }
  }

  private clearPendingLifecycle(lifecycleId: number | undefined): void {
    if (lifecycleId !== undefined && this.pendingLifecycle?.id === lifecycleId) {
      this.pendingLifecycle = undefined;
    }
  }
}
