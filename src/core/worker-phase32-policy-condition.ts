export type ConditionOperator = 'EQUALS' | 'NOT_EQUALS' | 'CONTAINS' | 'NOT_CONTAINS' | 'GREATER_THAN' | 'LESS_THAN' | 'GREATER_EQUAL' | 'LESS_EQUAL' | 'IN_LIST' | 'NOT_IN_LIST' | 'EXISTS' | 'NOT_EXISTS' | 'AND' | 'OR' | 'NOT';

export interface PolicyCondition {
  operator: ConditionOperator;
  field?: string;
  value?: unknown;
  children?: PolicyCondition[];
}

export function evaluateCondition(condition: PolicyCondition, context: Record<string, unknown>): boolean {
  switch (condition.operator) {
    case 'EQUALS': return context[condition.field!] === condition.value;
    case 'NOT_EQUALS': return context[condition.field!] !== condition.value;
    case 'CONTAINS': return String(context[condition.field!]).includes(String(condition.value));
    case 'NOT_CONTAINS': return !String(context[condition.field!]).includes(String(condition.value));
    case 'GREATER_THAN': return Number(context[condition.field!]) > Number(condition.value);
    case 'LESS_THAN': return Number(context[condition.field!]) < Number(condition.value);
    case 'GREATER_EQUAL': return Number(context[condition.field!]) >= Number(condition.value);
    case 'LESS_EQUAL': return Number(context[condition.field!]) <= Number(condition.value);
    case 'IN_LIST': return Array.isArray(condition.value) && condition.value.includes(context[condition.field!]);
    case 'NOT_IN_LIST': return Array.isArray(condition.value) && !condition.value.includes(context[condition.field!]);
    case 'EXISTS': return context[condition.field!] !== undefined;
    case 'NOT_EXISTS': return context[condition.field!] === undefined;
    case 'AND': return condition.children!.every(c => evaluateCondition(c, context));
    case 'OR': return condition.children!.some(c => evaluateCondition(c, context));
    case 'NOT': return !evaluateCondition(condition.children![0], context);
    default: return false;
  }
}
