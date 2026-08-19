import type { Unsubscribable } from 'rxjs';

import { LoadingState } from '@grafana/data';
import {
  type QueryRunnerState,
  SceneQueryRunner,
  type SceneTimeRangeLike,
  type SceneTimeRangeState,
  sceneGraph,
} from '@grafana/scenes';

import { getAncestorRefreshOrigin, getRefreshOrigin, RefreshOrigin } from './refresh-origin';

export interface DashboardQueryLifecycle {
  id: number;
  origin: RefreshOrigin;
  requestId?: string;
}

interface PendingDashboardQueryLifecycle extends DashboardQueryLifecycle {
  previousRequestId?: string;
}

interface QueuedQueryRun {
  lifecycle: PendingDashboardQueryLifecycle;
  timeRange: SceneTimeRangeLike;
}

interface CapturedRefreshOrigin {
  origin: RefreshOrigin;
  timeRange: SceneTimeRangeLike;
}

type RunWithTimeRange = (timeRange: SceneTimeRangeLike) => Promise<void>;

export class DashboardSceneQueryRunner extends SceneQueryRunner {
  private nextLifecycleId = 0;
  private pendingLifecycle?: PendingDashboardQueryLifecycle;
  private nextRunLifecycle?: PendingDashboardQueryLifecycle;
  private preparingLifecycleId?: number;
  private queuedRun?: QueuedQueryRun;
  private cancelledPreparations = new Set<number>();
  private refreshOriginTimeRange?: SceneTimeRangeLike;
  private refreshOriginSubscription?: Unsubscribable;
  private capturedRefreshOrigins: CapturedRefreshOrigin[] = [];
  private externalViewportBypass = false;
  private panelRefreshViewportBypass = false;

  public constructor(initialState: QueryRunnerState) {
    super(initialState);

    // SceneQueryRunner starts requests in a private async method after datasource resolution. Queueing that preparation
    // is the only way to prevent an older lookup from publishing the first request after a newer lifecycle has opened.
    const baseRunWithTimeRange: RunWithTimeRange = Reflect.get(this, 'runWithTimeRange').bind(this);
    Reflect.set(this, 'runWithTimeRange', (timeRange: SceneTimeRangeLike) =>
      this.scheduleRunWithTimeRange(baseRunWithTimeRange, timeRange)
    );

    this.addActivationHandler(() => {
      this.subscribeToRefreshOrigins();
      return () => {
        this.refreshOriginSubscription?.unsubscribe();
        this.refreshOriginSubscription = undefined;
        this.refreshOriginTimeRange = undefined;
        this.capturedRefreshOrigins = [];
      };
    });

    this.subscribeToState((newState, oldState) => {
      if (newState.data !== oldState.data) {
        this.handleDataStateChange(newState.data?.state, newState.data?.request?.requestId);
      }
    });
  }

  public override runQueries(): void {
    this.subscribeToRefreshOrigins();
    const lifecycle = this.openLifecycle();
    this.nextRunLifecycle = lifecycle;

    try {
      super.runQueries();
    } catch (error) {
      this.nextRunLifecycle = undefined;
      this.clearPendingLifecycle(lifecycle.id);
      throw error;
    }
  }

  public override cancelQuery(): void {
    const lifecycleId = this.pendingLifecycle?.id;
    this.nextRunLifecycle = undefined;
    this.queuedRun = undefined;
    if (this.preparingLifecycleId !== undefined) {
      this.cancelledPreparations.add(this.preparingLifecycleId);
    }

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

  private openLifecycle(origin = getRefreshOrigin() ?? RefreshOrigin.Global): PendingDashboardQueryLifecycle {
    const lifecycle = {
      id: ++this.nextLifecycleId,
      origin,
      previousRequestId: this.state.data?.request?.requestId,
    };
    this.pendingLifecycle = lifecycle;
    return lifecycle;
  }

  private scheduleRunWithTimeRange(
    baseRunWithTimeRange: RunWithTimeRange,
    timeRange: SceneTimeRangeLike
  ): Promise<void> {
    const lifecycle = this.nextRunLifecycle ?? this.openLifecycle(this.consumeRefreshOrigin(timeRange));
    this.nextRunLifecycle = undefined;

    if (this.preparingLifecycleId !== undefined) {
      this.queuedRun = { lifecycle, timeRange };
      return Promise.resolve();
    }

    return this.startRunWithTimeRange(baseRunWithTimeRange, { lifecycle, timeRange });
  }

  private subscribeToRefreshOrigins(): void {
    if ((this.state.runQueriesMode ?? 'auto') !== 'auto') {
      return;
    }

    // SceneQueryRunner defers time-range runs, so the synchronous refresh-origin scope is gone when its callback executes.
    const timeRange = sceneGraph.getTimeRange(this);
    if (this.refreshOriginTimeRange === timeRange) {
      return;
    }

    this.refreshOriginSubscription?.unsubscribe();
    this.refreshOriginTimeRange = timeRange;
    this.refreshOriginSubscription = timeRange.subscribeToState(
      (newState: SceneTimeRangeState, oldState: SceneTimeRangeState) => {
        this.capturedRefreshOrigins.push({
          origin: getAncestorRefreshOrigin(newState, oldState),
          timeRange,
        });
      }
    );
  }

  private consumeRefreshOrigin(timeRange: SceneTimeRangeLike): RefreshOrigin | undefined {
    const index = this.capturedRefreshOrigins.findIndex((captured) => captured.timeRange === timeRange);
    if (index === -1) {
      return undefined;
    }

    return this.capturedRefreshOrigins.splice(index, 1)[0].origin;
  }

  private async startRunWithTimeRange(baseRunWithTimeRange: RunWithTimeRange, run: QueuedQueryRun): Promise<void> {
    const lifecycleId = run.lifecycle.id;
    const querySubscriptionBeforeRun = this.getQuerySubscription();
    this.preparingLifecycleId = lifecycleId;

    try {
      await baseRunWithTimeRange(run.timeRange);
    } finally {
      const didStartRequest = this.getQuerySubscription() !== querySubscriptionBeforeRun;
      const wasCancelled = this.cancelledPreparations.delete(lifecycleId);

      if (wasCancelled && didStartRequest) {
        super.cancelQuery();
      } else if (!didStartRequest) {
        this.clearPendingLifecycle(lifecycleId);
      }

      this.preparingLifecycleId = undefined;
      const queuedRun = this.queuedRun;
      this.queuedRun = undefined;
      if (queuedRun) {
        await this.startRunWithTimeRange(baseRunWithTimeRange, queuedRun);
      }
    }
  }

  private getQuerySubscription(): unknown {
    return Reflect.get(this, '_querySub');
  }

  private handleDataStateChange(state: LoadingState | undefined, requestId: string | undefined): void {
    const lifecycle = this.pendingLifecycle;
    if (!lifecycle) {
      return;
    }

    if (this.preparingLifecycleId !== undefined && this.preparingLifecycleId !== lifecycle.id) {
      return;
    }

    if (state === LoadingState.Done || state === LoadingState.Error) {
      const isUnmatchedPreviousRequest =
        !lifecycle.requestId && requestId === lifecycle.previousRequestId && this.preparingLifecycleId !== lifecycle.id;
      if (!isUnmatchedPreviousRequest && (!lifecycle.requestId || requestId === lifecycle.requestId)) {
        this.clearPendingLifecycle(lifecycle.id);
      }
      return;
    }

    if (requestId && requestId !== lifecycle.previousRequestId && !lifecycle.requestId) {
      lifecycle.requestId = requestId;
    }
  }

  private clearPendingLifecycle(lifecycleId: number | undefined): void {
    if (lifecycleId !== undefined && this.pendingLifecycle?.id === lifecycleId) {
      this.pendingLifecycle = undefined;
    }
  }
}
