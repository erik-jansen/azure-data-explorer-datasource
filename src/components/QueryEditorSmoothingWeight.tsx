import React, { useCallback } from 'react';
import { css } from 'emotion';
import { SelectableValue } from '@grafana/data';
import { InlineFormLabel, Select, stylesFactory } from '@grafana/ui';

interface Props {
  weight: string;
  onChangeWeight: (weight: string) => void;
}

const weights: Array<SelectableValue<string>> = [
  { label: 'Low', value: '0' },
  { label: 'Medium', value: '1' },
  { label: 'High', value: '2' },
  { label: 'Max', value: '3' },
];

export const QueryEditorSmoothingWeight: React.FC<Props> = props => {
  const { onChangeWeight } = props;
  const onWeightChange = useCallback(
    (selectable: SelectableValue<string>) => {
      if (!selectable || !selectable.value) {
        return;
      }
      onChangeWeight(selectable.value);
    },
    [onChangeWeight]
  );

  const styles = getStyles();

  return (
    <div className={styles.container}>
      <InlineFormLabel className="query-keyword" width={6}>
        Weight
      </InlineFormLabel>
      <Select
        options={weights}
        value={props.weight}
        onChange={onWeightChange}
      />
    </div>
  );
};

const getStyles = stylesFactory(() => {
  return {
    container: css`
      display: flex;
      flex-direction: row;
      margin-right: 4px;
    `,
  };
});

export const selectSmoothingWeight = (weight?: string): string => {
  const selected = weights.find(f => f.value === weight);

  if (selected && selected.value) {
    return selected.value;
  }

  if (weights.length > 0 && weights[0].value) {
    return weights[0].value;
  }

  return '0';
};
