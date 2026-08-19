import { QueryOptionField } from './QueryEditor/types';
import { QUERY_OPTION_FIELD_CONFIG } from './constants';

describe('QUERY_OPTION_FIELD_CONFIG', () => {
  it('configures every query option field', () => {
    expect(Object.keys(QUERY_OPTION_FIELD_CONFIG)).toEqual(Object.values(QueryOptionField));
    expect(QUERY_OPTION_FIELD_CONFIG[QueryOptionField.refresh].getLabel()).toBe('Refresh');
    expect(QUERY_OPTION_FIELD_CONFIG[QueryOptionField.refresh].getTooltip()).toBe(
      'Manual refreshes and time range changes refresh every panel.'
    );
  });
});
