import type { Unsubscribable } from 'rxjs';

import { type DataQueryRequest, type DataSourceApi, LoadingState } from '@grafana/data';
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
  querySubscribed?: boolean;
}

interface CapturedRefreshOrigin {
  origin: RefreshOrigin;
  timeRange: SceneTimeRangeLike;
}

type RunWithTimeRange = (timeRange: SceneTimeRangeLike) => Promise<void>;
type PreparedRequests = { primary: DataQueryRequest };
type PrepareRequests = (timeRange: SceneTimeRangeLike, datasource: DataSourceApi) => PreparedRequests;

export class DashboardSceneQueryRunner extends SceneQueryRunner {
  private nextLifecycleId = 0;
  private pendingLifecycle?: PendingDashboardQueryLifecycle;
  private pendingLifecycles = new Map<number, PendingDashboardQueryLifecycle>();
  private lifecycleByRequestId = new Map<string, PendingDashboardQueryLifecycle>();
  private nextRunLifecycle?: PendingDashboardQueryLifecycle;
  private activePreparations = new Set<number>();
  private lifecycleByTimeRange = new WeakMap<SceneTimeRangeLike, PendingDashboardQueryLifecycle>();
  private querySetupLifecycle?: PendingDashboardQueryLifecycle;
  private refreshOriginTimeRange?: SceneTimeRangeLike;
  private refreshOriginSubscription?: Unsubscribable;
  private capturedRefreshOrigins: CapturedRefreshOrigin[] = [];
  private externalViewportBypass = false;
  private panelRefreshViewportBypass = false;

  public constructor(initialState: QueryRunnerState) {
    super(initialState);

    // The base runner creates request IDs after its async datasource lookup. A per-run time range context keeps
    // overlapping lookups correlated with their own lifecycle without changing when either lookup starts.
    const baseRunWithTimeRange: RunWithTimeRange = Reflect.get(this, 'runWithTimeRange').bind(this);
    Reflect.set(this, 'runWithTimeRange', (timeRange: SceneTimeRangeLike) =>
      this.trackRunWithTimeRange(baseRunWithTimeRange, timeRange)
    );
    const basePrepareRequests: PrepareRequests = Reflect.get(this, 'prepareRequests').bind(this);
    Reflect.set(this, 'prepareRequests', (timeRange: SceneTimeRangeLike, datasource: DataSourceApi) => {
      this.querySetupLifecycle = this.lifecycleByTimeRange.get(timeRange);
      const requests = basePrepareRequests(timeRange, datasource);
      const lifecycle = this.querySetupLifecycle;
      if (lifecycle) {
        this.setLifecycleRequestId(lifecycle, requests.primary.requestId);
      }
      return requests;
    });
    // A setup error is caught by the base runner and publishes the previous request, so observing subscription
    // assignment is the only lifecycle-local evidence that a prepared request actually started.
    let querySubscription: Unsubscribable | undefined = Reflect.get(this, '_querySub');
    Object.defineProperty(this, '_querySub', {
      configurable: true,
      get: () => querySubscription,
      set: (subscription: Unsubscribable | undefined) => {
        querySubscription = subscription;
        if (subscription && this.querySetupLifecycle) {
          this.querySetupLifecycle.querySubscribed = true;
        }
      },
    });

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

  public getLifecycleForRequest(requestId: string | undefined): Readonly<DashboardQueryLifecycle> | undefined {
    const lifecycle = this.findLifecycleForRequest(requestId);
    if (lifecycle) {
      const { id, origin, requestId } = lifecycle;
      return { id, origin, requestId };
    }

    return undefined;
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
    this.pendingLifecycles.set(lifecycle.id, lifecycle);
    return lifecycle;
  }

  private trackRunWithTimeRange(baseRunWithTimeRange: RunWithTimeRange, timeRange: SceneTimeRangeLike): Promise<void> {
    const lifecycle = this.nextRunLifecycle ?? this.openLifecycle(this.consumeRefreshOrigin(timeRange));
    this.nextRunLifecycle = undefined;
    this.retireSupersededLifecycles(lifecycle.id);
    const contextualTimeRange = this.createContextualTimeRange(timeRange, lifecycle);
    this.activePreparations.add(lifecycle.id);

    return baseRunWithTimeRange(contextualTimeRange).finally(() => {
      this.activePreparations.delete(lifecycle.id);
      if (this.querySetupLifecycle?.id === lifecycle.id) {
        this.querySetupLifecycle = undefined;
      }
      if (
        (!lifecycle.requestId && this.state.data?.state !== LoadingState.Loading) ||
        (lifecycle.requestId && !lifecycle.querySubscribed)
      ) {
        this.clearPendingLifecycle(lifecycle.id);
      }
    });
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

  private createContextualTimeRange(
    timeRange: SceneTimeRangeLike,
    lifecycle: PendingDashboardQueryLifecycle
  ): SceneTimeRangeLike {
    const contextualTimeRange = new Proxy(timeRange, {
      get: (target, property) => {
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    this.lifecycleByTimeRange.set(contextualTimeRange, lifecycle);
    return contextualTimeRange;
  }

  private handleDataStateChange(state: LoadingState | undefined, requestId: string | undefined): void {
    this.pruneLifecycleHistory(requestId);
    const failedLifecycle = this.findFailedSetupLifecycle(state, requestId);
    if (failedLifecycle) {
      this.associateLifecycleWithRequestId(failedLifecycle, requestId);
      this.completePendingLifecycle(failedLifecycle);
      return;
    }

    const lifecycle = this.findLifecycleForRequest(requestId);
    if (lifecycle) {
      if (state === LoadingState.Done || state === LoadingState.Error) {
        this.completePendingLifecycle(lifecycle);
      }
      return;
    }

    const pendingLifecycle = this.pendingLifecycle;
    if (!pendingLifecycle) {
      return;
    }

    if (state === LoadingState.Done || state === LoadingState.Error) {
      if (
        !pendingLifecycle.requestId &&
        !this.activePreparations.has(pendingLifecycle.id) &&
        requestId !== pendingLifecycle.previousRequestId
      ) {
        this.setLifecycleRequestId(pendingLifecycle, requestId);
        this.completePendingLifecycle(pendingLifecycle);
      }
      return;
    }

    if (
      requestId &&
      requestId !== pendingLifecycle.previousRequestId &&
      !pendingLifecycle.requestId &&
      !this.activePreparations.has(pendingLifecycle.id)
    ) {
      this.setLifecycleRequestId(pendingLifecycle, requestId);
    }
  }

  private setLifecycleRequestId(lifecycle: PendingDashboardQueryLifecycle, requestId: string | undefined): void {
    if (!requestId) {
      return;
    }

    lifecycle.requestId = requestId;
    this.lifecycleByRequestId.set(requestId, lifecycle);
  }

  private associateLifecycleWithRequestId(
    lifecycle: PendingDashboardQueryLifecycle,
    requestId: string | undefined
  ): void {
    if (requestId) {
      this.lifecycleByRequestId.set(requestId, lifecycle);
    }
  }

  private findFailedSetupLifecycle(
    state: LoadingState | undefined,
    requestId: string | undefined
  ): PendingDashboardQueryLifecycle | undefined {
    if (state !== LoadingState.Error) {
      return undefined;
    }

    const setupLifecycle = this.querySetupLifecycle;
    if (setupLifecycle && !setupLifecycle.querySubscribed && this.activePreparations.has(setupLifecycle.id)) {
      return setupLifecycle;
    }

    const pendingLifecycle = this.pendingLifecycle;
    if (pendingLifecycle && !pendingLifecycle.querySubscribed && requestId === pendingLifecycle.previousRequestId) {
      return pendingLifecycle;
    }

    return undefined;
  }

  private findLifecycleForRequest(requestId: string | undefined): PendingDashboardQueryLifecycle | undefined {
    if (!requestId) {
      return undefined;
    }

    const lifecycle =
      this.lifecycleByRequestId.get(requestId) ??
      Array.from(this.pendingLifecycles.values()).find((pending) => pending.requestId === requestId);
    if (lifecycle) {
      this.lifecycleByRequestId.set(requestId, lifecycle);
    }
    return lifecycle;
  }

  private pruneLifecycleHistory(currentRequestId: string | undefined): void {
    for (const [requestId, lifecycle] of this.lifecycleByRequestId) {
      if (requestId !== currentRequestId && !this.pendingLifecycles.has(lifecycle.id)) {
        this.lifecycleByRequestId.delete(requestId);
      }
    }
  }

  private retireSupersededLifecycles(currentLifecycleId: number): void {
    for (const lifecycle of this.pendingLifecycles.values()) {
      const skippedPreparation = !lifecycle.requestId && !this.activePreparations.has(lifecycle.id);
      if (lifecycle.id !== currentLifecycleId && (lifecycle.querySubscribed || skippedPreparation)) {
        this.discardPendingLifecycle(lifecycle);
      }
    }
  }

  private discardPendingLifecycle(lifecycle: PendingDashboardQueryLifecycle): void {
    this.clearPendingLifecycle(lifecycle.id);
    for (const [requestId, mappedLifecycle] of this.lifecycleByRequestId) {
      if (mappedLifecycle.id === lifecycle.id) {
        this.lifecycleByRequestId.delete(requestId);
      }
    }
  }

  private clearPendingLifecycle(lifecycleId: number | undefined): void {
    if (lifecycleId === undefined) {
      return;
    }

    this.pendingLifecycles.delete(lifecycleId);
    if (this.pendingLifecycle?.id === lifecycleId) {
      this.pendingLifecycle = undefined;
    }
  }

  private completePendingLifecycle(lifecycle: PendingDashboardQueryLifecycle): void {
    this.clearPendingLifecycle(lifecycle.id);
  }
}
