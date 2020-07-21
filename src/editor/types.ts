export enum QueryEditorFieldType {
  Number = 'number',
  String = 'string',
  Boolean = 'boolean',
  DateTime = 'dateTime',
  Function = 'function',
  Interval = 'interval',
}

export enum QueryEditorCondition {
  And = 'and',
  Or = 'or',
}

export interface QueryEditorOperatorDefinition {
  value: string;
  supportTypes: QueryEditorFieldType[];
  multipleValues: boolean;
  booleanValues: boolean;
  label?: string;
  description?: string;
}

export interface QueryEditorFieldDefinition {
  value: string;
  type: QueryEditorFieldType;
  label?: string;
}
