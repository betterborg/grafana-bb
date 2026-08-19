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
type SubscribeToTimeRangeChanges = (timeRange: SceneTimeRangeLike) => void;

export class DashboardSceneQueryRunner extends SceneQueryRunner {
  private nextLifecycleId = 0;
  private pendingLifecycle?: PendingDashboardQueryLifecycle;
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
        lifecycle.requestId = requests.primary.requestId;
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

  public rebindToCurrentTimeRange(): void {
    if (!this.isActive || (this.state.runQueriesMode ?? 'auto') !== 'auto') {
      return;
    }

    const timeRange = sceneGraph.getTimeRange(this);
    // The base runner keeps its original time-range subscription until activation ends, while panel policy can add one live.
    const subscribeToTimeRangeChanges: SubscribeToTimeRangeChanges = Reflect.get(
      this,
      'subscribeToTimeRangeChanges'
    ).bind(this);
    subscribeToTimeRangeChanges(timeRange);
    this.subscribeToRefreshOrigins();
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

  private trackRunWithTimeRange(baseRunWithTimeRange: RunWithTimeRange, timeRange: SceneTimeRangeLike): Promise<void> {
    const lifecycle = this.nextRunLifecycle ?? this.openLifecycle(this.consumeRefreshOrigin(timeRange));
    this.nextRunLifecycle = undefined;
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
    const lifecycle = this.pendingLifecycle;
    if (!lifecycle) {
      return;
    }

    if (state === LoadingState.Done || state === LoadingState.Error) {
      if (lifecycle.requestId) {
        if (requestId === lifecycle.requestId) {
          this.clearPendingLifecycle(lifecycle.id);
        }
      } else if (!this.activePreparations.has(lifecycle.id) && requestId !== lifecycle.previousRequestId) {
        this.clearPendingLifecycle(lifecycle.id);
      }
      return;
    }

    if (
      requestId &&
      requestId !== lifecycle.previousRequestId &&
      !lifecycle.requestId &&
      !this.activePreparations.has(lifecycle.id)
    ) {
      lifecycle.requestId = requestId;
    }
  }

  private clearPendingLifecycle(lifecycleId: number | undefined): void {
    if (lifecycleId !== undefined && this.pendingLifecycle?.id === lifecycleId) {
      this.pendingLifecycle = undefined;
    }
  }
}
