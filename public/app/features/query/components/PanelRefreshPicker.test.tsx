import { render, screen, userEvent } from 'test/test-utils';

import config from 'app/core/config';
import { contextSrv } from 'app/core/services/context_srv';

import { PanelRefreshPicker } from './PanelRefreshPicker';

describe('PanelRefreshPicker', () => {
  const originalMinimum = config.minRefreshInterval;
  const originalContextMinimum = contextSrv.minRefreshInterval;

  beforeEach(() => {
    config.minRefreshInterval = '10s';
    contextSrv.minRefreshInterval = '10s';
  });

  afterEach(() => {
    config.minRefreshInterval = originalMinimum;
    contextSrv.minRefreshInterval = originalContextMinimum;
  });

  it('orders Default, Off, and configured intervals while filtering values below the floor', async () => {
    render(<PanelRefreshPicker intervals={['5s', '10s', '1m', '24d', '25d']} onChange={jest.fn()} />);

    await userEvent.click(screen.getByRole('combobox', { name: 'Refresh' }));

    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Default',
      'Off',
      '10s',
      '1m',
      '24d',
    ]);
  });

  it('offers and accepts only valid custom durations at or above the floor', async () => {
    const onChange = jest.fn();
    render(<PanelRefreshPicker intervals={['10s', '1m']} onChange={onChange} />);
    const picker = screen.getByRole('combobox', { name: 'Refresh' });

    await userEvent.type(picker, '5s');
    expect(screen.queryByRole('option', { name: 'Use custom interval: 5s' })).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();

    await userEvent.clear(picker);
    await userEvent.type(picker, '10s');
    expect(screen.queryByRole('option', { name: 'Use custom interval: 10s' })).not.toBeInTheDocument();

    await userEvent.clear(picker);
    await userEvent.type(picker, 'not-a-duration');
    expect(screen.queryByRole('option', { name: 'Use custom interval: not-a-duration' })).not.toBeInTheDocument();

    for (const interval of ['1.5s', '20s 10s', '1m30s']) {
      await userEvent.clear(picker);
      await userEvent.type(picker, interval);
      expect(screen.queryByRole('option', { name: `Use custom interval: ${interval}` })).not.toBeInTheDocument();
    }

    await userEvent.clear(picker);
    await userEvent.type(picker, '45s');
    await userEvent.click(screen.getByRole('option', { name: 'Use custom interval: 45s' }));
    expect(onChange).toHaveBeenCalledWith('45s');
  });

  it('rejects custom durations above the maximum timer delay', async () => {
    render(<PanelRefreshPicker onChange={jest.fn()} />);
    const picker = screen.getByRole('combobox', { name: 'Refresh' });

    await userEvent.type(picker, '24d');
    expect(screen.getByRole('option', { name: 'Use custom interval: 24d' })).toBeInTheDocument();

    for (const interval of ['25d', '4w', '1M', '1y']) {
      await userEvent.clear(picker);
      await userEvent.type(picker, interval);
      expect(screen.queryByRole('option', { name: `Use custom interval: ${interval}` })).not.toBeInTheDocument();
    }
  });

  it('commits configured and custom intervals with Enter', async () => {
    const onChange = jest.fn();
    render(<PanelRefreshPicker intervals={['10s', '1m']} onChange={onChange} />);
    const picker = screen.getByRole('combobox', { name: 'Refresh' });

    await userEvent.type(picker, '10s{enter}');
    expect(onChange).toHaveBeenLastCalledWith('10s');

    await userEvent.clear(picker);
    await userEvent.type(picker, '45s{enter}');
    expect(onChange).toHaveBeenLastCalledWith('45s');
  });

  it('emits the controlled values for Default, Off, and configured intervals', async () => {
    const onChange = jest.fn();
    const { rerender } = render(<PanelRefreshPicker value="10s" intervals={['10s', '1m']} onChange={onChange} />);

    await selectOption('Default');
    expect(onChange).toHaveBeenLastCalledWith(undefined);

    rerender(<PanelRefreshPicker value={undefined} intervals={['10s', '1m']} onChange={onChange} />);
    await selectOption('Off');
    expect(onChange).toHaveBeenLastCalledWith('off');

    rerender(<PanelRefreshPicker value="off" intervals={['10s', '1m']} onChange={onChange} />);
    await selectOption('1m');
    expect(onChange).toHaveBeenLastCalledWith('1m');
  });

  it('explains that global refresh actions still refresh every panel', () => {
    render(<PanelRefreshPicker onChange={jest.fn()} />);

    const picker = screen.getByRole('combobox', { name: 'Refresh' });
    expect(picker).toHaveAccessibleDescription('Manual refreshes and time range changes refresh every panel.');
  });

  it('can omit its field label when a consumer provides the field chrome', () => {
    render(<PanelRefreshPicker hideLabel onChange={jest.fn()} />);

    expect(screen.queryByText('Refresh')).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Panel refresh interval' })).toBeInTheDocument();
  });

});

async function selectOption(name: string) {
  await userEvent.click(screen.getByRole('combobox', { name: 'Refresh' }));
  await userEvent.click(screen.getByRole('option', { name }));
}
