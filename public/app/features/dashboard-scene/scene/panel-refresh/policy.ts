import { rangeUtil } from '@grafana/data';
import { config } from '@grafana/runtime';

export enum PanelRefreshPolicy {
  Inherit = 'inherit',
  Interval = 'interval',
  Off = 'off',
}

export function getPanelRefreshPolicy(refresh?: string): PanelRefreshPolicy {
  if (!refresh) {
    return PanelRefreshPolicy.Inherit;
  }

  if (refresh.toLowerCase() === PanelRefreshPolicy.Off) {
    return PanelRefreshPolicy.Off;
  }

  try {
    return rangeUtil.intervalToMs(refresh) > 0 ? PanelRefreshPolicy.Interval : PanelRefreshPolicy.Inherit;
  } catch {
    return PanelRefreshPolicy.Inherit;
  }
}

export function getPanelRefreshInterval(refresh?: string): number | undefined {
  if (getPanelRefreshPolicy(refresh) !== PanelRefreshPolicy.Interval) {
    return undefined;
  }

  const interval = rangeUtil.intervalToMs(refresh!);
  if (!config.minRefreshInterval) {
    return interval;
  }

  return Math.max(interval, rangeUtil.intervalToMs(config.minRefreshInterval));
}

export function getPanelRefreshValue(model: object): string | undefined {
  const refresh = Reflect.get(model, 'refresh');
  return typeof refresh === 'string' ? refresh : undefined;
}
