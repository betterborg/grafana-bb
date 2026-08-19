import { rangeUtil } from '@grafana/data';

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

  return rangeUtil.intervalToMs(refresh!);
}

export function getPanelRefreshValue(model: object): string | undefined {
  const refresh = Reflect.get(model, 'refresh');
  return typeof refresh === 'string' ? refresh : undefined;
}
