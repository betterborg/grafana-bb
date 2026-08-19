import { useCallback, useMemo, useState, type KeyboardEvent } from 'react';
import { components, type InputProps } from 'react-select';

import { rangeUtil, type SelectableValue } from '@grafana/data';
import { t } from '@grafana/i18n';
import { defaultIntervals, InlineField, InlineFieldRow, Select } from '@grafana/ui';
import { contextSrv } from 'app/core/services/context_srv';

const defaultValue = '__default';
const offValue = 'off';
const maxPanelRefreshIntervalMs = 2_147_483_647;
const panelRefreshIntervalPattern = /^\d+(?:ms|[wdhms])$/;

function isWithinMaxRefreshInterval(interval: string) {
  try {
    const intervalMs = rangeUtil.intervalToMs(interval);
    return intervalMs > 0 && intervalMs <= maxPanelRefreshIntervalMs;
  } catch {
    return false;
  }
}

function RefreshPickerInput(props: InputProps) {
  return <components.Input {...props} aria-describedby="panel-refresh-picker-description" />;
}

export interface PanelRefreshPickerProps {
  value?: string | null;
  intervals?: string[];
  onChange: (value: string | undefined) => void;
  hideLabel?: boolean;
}

export function PanelRefreshPicker({
  value,
  intervals = defaultIntervals,
  onChange,
  hideLabel = false,
}: PanelRefreshPickerProps) {
  const [inputValue, setInputValue] = useState('');
  const validIntervals = useMemo(
    () => contextSrv.getValidIntervals(intervals).filter(isWithinMaxRefreshInterval),
    [intervals]
  );
  const options = useMemo<Array<SelectableValue<string>>>(
    () => [
      {
        label: t('query.panel-refresh-picker.default', 'Default'),
        value: defaultValue,
      },
      {
        label: t('query.panel-refresh-picker.off', 'Off'),
        value: offValue,
      },
      ...validIntervals.map((interval) => ({ label: interval, value: interval })),
    ],
    [validIntervals]
  );

  const normalizedValue = !value ? defaultValue : value.toLowerCase() === offValue ? offValue : value;
  const selectedValue = options.find((option) => option.value === normalizedValue) ?? {
    label: normalizedValue,
    value: normalizedValue,
  };

  const isValidCustomInterval = useCallback(
    (input: string) => {
      const interval = input.trim();
      if (!panelRefreshIntervalPattern.test(interval) || validIntervals.includes(interval)) {
        return false;
      }

      return isWithinMaxRefreshInterval(interval) && contextSrv.getValidIntervals([interval]).length === 1;
    },
    [validIntervals]
  );

  const onSelect = useCallback(
    (option: SelectableValue<string>) => {
      if (option.value === defaultValue) {
        onChange(undefined);
      } else if (option.value === offValue) {
        onChange(offValue);
      } else if (option.value) {
        onChange(option.value);
      }
    },
    [onChange]
  );

  const onCreateOption = useCallback(
    (input: string) => {
      const interval = input.trim();
      if (isValidCustomInterval(interval)) {
        onChange(interval);
      }
    },
    [isValidCustomInterval, onChange]
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== 'Enter' || !inputValue) {
        return;
      }

      const matchingOption = options.find((option) => option.label?.toLowerCase() === inputValue.toLowerCase());
      if (matchingOption) {
        event.preventDefault();
        onSelect(matchingOption);
      } else if (isValidCustomInterval(inputValue)) {
        event.preventDefault();
        onCreateOption(inputValue);
      }
    },
    [inputValue, isValidCustomInterval, onCreateOption, onSelect, options]
  );

  const description = t(
    'query.panel-refresh-picker.description',
    'Manual refreshes and time range changes refresh every panel.'
  );

  const picker = (
    <div>
      <Select
        inputId="panel-refresh-picker"
        aria-label={hideLabel ? t('query.panel-refresh-picker.aria-label', 'Panel refresh interval') : undefined}
        components={{ Input: RefreshPickerInput }}
        options={options}
        value={selectedValue}
        onChange={onSelect}
        onInputChange={setInputValue}
        onKeyDown={onKeyDown}
        allowCustomValue
        createOptionPosition="last"
        isValidNewOption={isValidCustomInterval}
        onCreateOption={onCreateOption}
        width={25}
        formatCreateLabel={(input) =>
          t('query.panel-refresh-picker.custom-option', 'Use custom interval: {{interval}}', { interval: input })
        }
      />
      <span id="panel-refresh-picker-description" className="sr-only">
        {description}
      </span>
    </div>
  );

  if (hideLabel) {
    return picker;
  }

  return (
    <InlineFieldRow>
      <InlineField
        label={t('query.panel-refresh-picker.label', 'Refresh')}
        tooltip={description}
        htmlFor="panel-refresh-picker"
      >
        {picker}
      </InlineField>
    </InlineFieldRow>
  );
}
