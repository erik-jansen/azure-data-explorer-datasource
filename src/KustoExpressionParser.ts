import { QueryExpression, AdxColumnSchema, AutoCompleteQuery } from './types';
import { QueryEditorPropertyType } from 'editor/types';
import { getTemplateSrv, TemplateSrv } from '@grafana/runtime';
import {
  isReduceExpression,
  isFieldAndOperator,
  isGroupBy,
  isOrExpression,
  isAndExpression,
  isArrayExpression,
} from './editor/guards';
import {
  QueryEditorExpression,
  QueryEditorOperatorExpression,
  QueryEditorArrayExpression,
  QueryEditorPropertyExpression,
} from './editor/expressions';
import { cloneDeep, toInteger } from 'lodash';

interface ParseContext {
  timeColumn?: string;
  castIfDynamic: (column: string) => string;
}
export class KustoExpressionParser {
  constructor(private templateSrv: TemplateSrv = getTemplateSrv()) {}

  toAutoCompleteQuery(query?: AutoCompleteQuery, tableSchema?: AdxColumnSchema[]): string {
    if (!query?.expression || !query.expression.from || !query.search.property) {
      return '';
    }

    const context: ParseContext = {
      timeColumn: defaultTimeColumn(tableSchema, query?.expression),
      castIfDynamic: (column: string) => castIfDynamic(column, tableSchema),
    };

    const parts: string[] = [];
    this.appendProperty(context, query.expression.from, parts);
    this.appendTimeFilter(context, undefined, parts);

    const where = replaceByIndex(query.index, query.expression.where, query.search);
    const column = query.search.property.name;
    this.appendWhere(context, where, parts, 'where');

    parts.push('take 50000');
    parts.push(`distinct ${context.castIfDynamic(column)}`);
    parts.push('take 251');

    return parts.join('\n| ');
  }

  toQuery(expression?: QueryExpression, tableSchema?: AdxColumnSchema[]): string {
    if (!expression || !expression.from) {
      return '';
    }

    const context: ParseContext = {
      timeColumn: defaultTimeColumn(tableSchema, expression),
      castIfDynamic: (column: string) => castIfDynamic(column, tableSchema),
    };

    const parts: string[] = [];
    this.appendProperty(context, expression.from, parts);
    this.appendTimeFilter(context, expression.timeshift, parts);
    this.appendWhere(context, expression?.where, parts, 'where');
    this.appendTimeshift(context, expression.timeshift, parts);
    this.appendSummarize(context, expression.smoothing, expression.reduce, expression.groupBy, parts);
    this.appendSmoothing(context, expression.smoothing, expression.reduce, expression.groupBy, parts);
    this.appendOrderBy(context, expression.groupBy, expression.reduce, parts);

    if (parts.length === 0) {
      return '';
    }

    return parts.join('\n| ');
  }

  private appendSmoothing(
    context: ParseContext,
    smoothingExpression: QueryEditorPropertyExpression | undefined,
    reduceExpression: QueryEditorArrayExpression,
    groupByExpression: QueryEditorArrayExpression,
    parts: string[]
  ) {
    const smoothing = detectSmoothing(smoothingExpression);
    const noGroupBy = Array.isArray(groupByExpression.expressions) && groupByExpression.expressions.length === 0;
    const noReduce = Array.isArray(reduceExpression.expressions) && reduceExpression.expressions.length === 0;
    const groupByParts: string[] = [];

    if(!smoothing || noReduce || noGroupBy) {
      return;
    }

    var reduceFunc = "";
    var reduceColumn = "";
    for (const expression of reduceExpression?.expressions ?? []) {
      if (!isReduceExpression(expression)) {
        continue;
      }

      reduceFunc = expression.reduce.name;
      reduceColumn = context.castIfDynamic(expression.property.name);
    }

    var groupByInterval = "";
    for (const expression of groupByExpression?.expressions ?? []) {
      if (!isGroupBy(expression)) {
        continue;
      }

      const column = context.castIfDynamic(expression.property.name);

      if (expression.interval) {
        groupByInterval = expression.interval.name;
        continue;
      }

      groupByParts.push(column);
    }

    if(smoothing != "median") {
      if (groupByParts.length > 0) {
        parts.push(`make-series a=${reduceFunc}(${reduceColumn}) on ${context.timeColumn} from $__timeFrom to $__timeTo step ${groupByInterval} by ${groupByParts.join(', ')}`);
      }
      else {
        parts.push(`make-series a=${reduceFunc}(${reduceColumn}) on ${context.timeColumn} from $__timeFrom to $__timeTo step ${groupByInterval}`);
      }
      if(smoothing == "ewma") {
        parts.push(`extend b=series_exp_smoothing_udf(a, ${translateSmoothingWeight(smoothing, "1")})`);
      }
      if(smoothing == "auto") {
        parts.push(`extend b=series_moving_avg_udf(a, 10, false)`);
      }
      parts.push(`mv-expand ${context.timeColumn} to typeof(datetime), b to typeof(real)`);
      if (groupByParts.length > 0) {
        parts.push(`project ${context.timeColumn}, b, ${groupByParts.join(', ')}`);
      }
      else {
        parts.push(`project ${context.timeColumn}, b`);
      }
    }
    else {
      if (groupByParts.length > 0) {
        parts.push(`evaluate rolling_percentile(${reduceFunc}_${reduceColumn}, 50, ${context.timeColumn}, ${groupByInterval}, ${translateSmoothingWeight(smoothing, "1")}, ${groupByParts.join(', ')})`);
      }
      else {
        parts.push(`evaluate rolling_percentile(${reduceFunc}_${reduceColumn}, 50, ${context.timeColumn}, ${groupByInterval}, ${translateSmoothingWeight(smoothing, "1")})`);
      }
    }
  }

  private appendTimeshift(
    context: ParseContext,
    expression: QueryEditorPropertyExpression | undefined,
    parts: string[]
  ) {
    const timeshift = detectTimeshift(context, expression);

    if (!timeshift) {
      return;
    }
    parts.push(`extend ${context.timeColumn} = ${context.timeColumn} + ${timeshift}`);
  }

  private appendTimeFilter(
    context: ParseContext,
    expression: QueryEditorPropertyExpression | undefined,
    parts: string[]
  ) {
    if (!context.timeColumn) {
      return;
    }

    const timeshift = detectTimeshift(context, expression);

    if (timeshift) {
      parts.push(`where ${context.timeColumn} between (($__timeFrom - ${timeshift}) .. ($__timeTo - ${timeshift}))`);
      return;
    }

    if (isDynamic(context.timeColumn)) {
      parts.push(`where ${context.timeColumn} between ($__timeFrom .. $__timeTo)`);
      return;
    }

    parts.push(`where $__timeFilter(${context.timeColumn})`);
  }

  private appendOrderBy(
    context: ParseContext,
    groupBy: QueryEditorArrayExpression,
    reduce: QueryEditorArrayExpression,
    parts: string[]
  ) {
    if (!context.timeColumn) {
      return;
    }

    const noGroupBy = Array.isArray(groupBy.expressions) && groupBy.expressions.length === 0;
    const noReduce = Array.isArray(reduce.expressions) && reduce.expressions.length === 0;

    if (noGroupBy && noReduce) {
      parts.push(`order by ${context.timeColumn} asc`);
      return;
    }

    const hasInterval = groupBy.expressions.find(exp => {
      if (!isGroupBy(exp) || !exp.interval) {
        return false;
      }
      return true;
    });

    if (hasInterval) {
      parts.push(`order by ${context.timeColumn} asc`);
      return;
    }
  }

  private appendWhere(
    context: ParseContext,
    expression: QueryEditorExpression | undefined,
    parts: string[],
    prefix?: string
  ) {
    if (!expression) {
      return;
    }

    if (isAndExpression(expression)) {
      return expression.expressions.forEach(exp => this.appendWhere(context, exp, parts, prefix));
    }

    if (isOrExpression(expression)) {
      const orParts: string[] = [];
      expression.expressions.map(exp => this.appendWhere(context, exp, orParts));
      if (orParts.length === 0) {
        return;
      }
      return parts.push(`where ${orParts.join(' or ')}`);
    }

    if (isFieldAndOperator(expression)) {
      return this.appendOperator(context, expression, parts, prefix);
    }
  }

  private appendSummarize(
    context: ParseContext,
    smoothingExpr: QueryEditorPropertyExpression | undefined,
    reduce: QueryEditorArrayExpression | undefined,
    groupBy: QueryEditorArrayExpression | undefined,
    parts: string[]
  ) {
    const smoothing = detectSmoothing(smoothingExpr);
    if(smoothing && smoothing != "median") {
      return;
    }

    let countAddedInReduce = false;
    const reduceParts: string[] = [];
    const groupByParts: string[] = [];
    const columns: string[] = [];

    for (const expression of reduce?.expressions ?? []) {
      if (!isReduceExpression(expression)) {
        continue;
      }

      const func = expression.reduce.name;
      const parameters = expression.parameters;
      const column = context.castIfDynamic(expression.property.name);
      columns.push(column);

      if (Array.isArray(parameters)) {
        const funcParams = parameters.map(p => this.formatValue(p.value, p.fieldType)).join(', ');
        reduceParts.push(`${func}(${column}, ${funcParams})`);
        continue;
      }

      if (func === 'count') {
        if (!countAddedInReduce) {
          countAddedInReduce = true;
          reduceParts.push('count()');
        }
        continue;
      }

      if (func !== 'none') {
        reduceParts.push(`${func}(${column})`);
        continue;
      }
    }

    for (const expression of groupBy?.expressions ?? []) {
      if (!isGroupBy(expression)) {
        continue;
      }

      const column = context.castIfDynamic(expression.property.name);

      if (expression.interval) {
        const interval = expression.interval.name;
        groupByParts.unshift(`bin(${column}, ${interval})`);
        continue;
      }

      groupByParts.push(column);
    }

    if (reduceParts.length > 0) {
      if (groupByParts.length > 0) {
        parts.push(`summarize ${reduceParts.join(', ')} by ${groupByParts.join(', ')}`);
        return;
      }
      parts.push(`summarize ${reduceParts.join(', ')}`);
      return;
    }

    if (groupByParts.length > 0) {
      parts.push(`summarize by ${groupByParts.join(', ')}`);
      return;
    }

    if (columns.length > 0) {
      parts.push(`project ${columns.join(', ')}`);
      return;
    }
  }

  private appendOperator(
    context: ParseContext,
    expression: QueryEditorOperatorExpression,
    parts: string[],
    prefix?: string
  ) {
    const { property, operator } = expression;

    if (!property.name || !operator.name) {
      return;
    }

    switch (operator.name) {
      case 'isnotempty':
        parts.push(withPrefix(`${operator.name}(${property.name})`, prefix));
        break;

      default:
        const value = this.formatValue(operator.value, property.type);
        parts.push(withPrefix(`${property.name} ${operator.name} ${value}`, prefix));
        break;
    }
  }

  private formatValue(value: any, type: QueryEditorPropertyType): string {
    if (Array.isArray(value)) {
      return `(${value.map(v => this.formatValue(v, type)).join(', ')})`;
    }

    if (this.isTemplateVariable(value)) {
      return value;
    }

    switch (type) {
      case QueryEditorPropertyType.Number:
      case QueryEditorPropertyType.Boolean:
        return value;
      default:
        return `'${value}'`;
    }
  }

  private appendProperty(context: ParseContext, expression: QueryEditorPropertyExpression, parts: string[]) {
    parts.push(expression.property.name);
  }

  private isTemplateVariable(value: string): boolean {
    if (!Array.isArray(this.templateSrv.getVariables())) {
      return false;
    }

    return !!this.templateSrv.getVariables().find((variable: any) => {
      return `$${variable?.id}` === value;
    });
  }
}

const withPrefix = (value: string, prefix?: string): string => {
  if (prefix) {
    return `${prefix} ${value}`;
  }
  return value;
};

const defaultTimeColumn = (columns?: AdxColumnSchema[], expression?: QueryExpression): string | undefined => {
  if (Array.isArray(expression?.groupBy.expressions)) {
    const groupByTimeColumn = expression?.groupBy.expressions.find(exp => {
      if (!isGroupBy(exp)) {
        return false;
      }
      return exp.property.type === QueryEditorPropertyType.DateTime && exp.interval;
    });

    if (isGroupBy(groupByTimeColumn)) {
      return castIfDynamic(groupByTimeColumn.property.name, columns);
    }
  }

  if (!Array.isArray(columns)) {
    return;
  }

  const firstLevelColumn = columns?.find(col => {
    return col.CslType === 'datetime' && col.Name.indexOf('.') === -1;
  });

  if (firstLevelColumn) {
    return firstLevelColumn?.Name;
  }

  const column = columns?.find(col => col.CslType === 'datetime');

  if (!column) {
    return column;
  }

  return toDynamic(column);
};

const isDynamic = (column: string): boolean => {
  return !!(column && column.indexOf('.') > -1) || !!(column && column.indexOf('todynamic') > -1);
};

const castIfDynamic = (column: string, tableSchema?: AdxColumnSchema[]): string => {
  if (!isDynamic(column) || !Array.isArray(tableSchema)) {
    return column;
  }

  const columnSchema = tableSchema.find(c => c.Name === column);

  if (!columnSchema) {
    return column;
  }

  return toDynamic(columnSchema);
};

const toDynamic = (column: AdxColumnSchema): string => {
  const parts = column.Name.split('.');

  return parts.reduce((result: string, part, index) => {
    if (!result) {
      return `todynamic(${part})`;
    }

    if (index + 1 === parts.length) {
      return `to${column.CslType}(${result}.${part})`;
    }

    return `todynamic(${result}.${part})`;
  }, '');
};

const replaceByIndex = (
  index: string,
  expression: QueryEditorArrayExpression,
  operator: QueryEditorOperatorExpression
): QueryEditorArrayExpression => {
  const keys = index.split('-').map(n => parseInt(n, 10));

  let where = cloneDeep(expression);
  let current = where.expressions;

  for (let index = 0; index < keys.length; index++) {
    const key = keys[index];

    if (index === keys.length - 1) {
      current[key] = operator;
      break;
    }

    if (Array.isArray(current)) {
      const exp = current[key];

      if (isArrayExpression(exp)) {
        current = exp.expressions;
        continue;
      }
    }
  }

  return where;
};

const isValidTimeSpan = (value: string) => {
  return /^(\d{1,15}(?:d|h|ms|s|m){0,1})$/gm.test(value);
};

const detectTimeshift = (
  context: ParseContext,
  timeshift: QueryEditorPropertyExpression | undefined
): string | null => {
  if (!timeshift || !context.timeColumn || !timeshift.property) {
    return null;
  }

  const timeshiftWith = timeshift.property.name;

  if (!isValidTimeSpan(timeshiftWith)) {
    return null;
  }
  return timeshiftWith;
};

const detectSmoothing = (
  smoothing: QueryEditorPropertyExpression | undefined
): string | null => {
  if(!smoothing || !smoothing.property) {
    return null;
  }

  const smoothingWith = smoothing.property.name;

  return smoothingWith;
}

const translateSmoothingWeight = (
  smoothing: string,
  weight: string,
): string | null => {
  const ewmaWeights = ["0.7", "0.5", "0.3", "0.1"];
  const medianWeights = ["3", "5", "7", "9"];

  if(smoothing == "median")
  {
    return medianWeights[toInteger(weight)];
  }
  else if (smoothing == "ewma")
  {
    return ewmaWeights[toInteger(weight)];
  }

  return null;
}