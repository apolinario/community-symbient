/**
 * Condition Evaluator — safe predicate evaluation for watch filters.
 *
 * Watches declare an `on.where` expression like:
 *   "temp >= 82"
 *   "temp >= 82 && trend == 'rising'"
 *   "direction == 'in' && chat == 'group'"
 *
 * We parse it once with jsep and evaluate against an event's fields.
 * No arbitrary JS — only a small, explicit subset is allowed:
 *   - Identifiers resolve to event fields (dotted paths supported via member access).
 *   - Literals: strings, numbers, true/false, null.
 *   - Binary ops: == != < <= > >= && ||.
 *   - Unary: ! -.
 *
 * Anything else (function calls, assignments, bitwise, ternary...) throws.
 * This keeps watches declarative and prevents injection via workspace edits.
 */

import jsep from "jsep";

type Ast = any;

const BINARY: Record<string, (a: any, b: any) => any> = {
  "==": (a, b) => a == b,
  "===": (a, b) => a === b,
  "!=": (a, b) => a != b,
  "!==": (a, b) => a !== b,
  "<": (a, b) => a < b,
  "<=": (a, b) => a <= b,
  ">": (a, b) => a > b,
  ">=": (a, b) => a >= b,
  "&&": (a, b) => a && b,
  "||": (a, b) => a || b,
};

function evalNode(node: Ast, scope: Record<string, unknown>): unknown {
  switch (node.type) {
    case "Literal":
      return node.value;
    case "Identifier":
      return scope[node.name];
    case "MemberExpression": {
      // Only dotted access with identifier properties. `a.b.c`
      const obj = evalNode(node.object, scope);
      if (obj === undefined || obj === null) return undefined;
      if (node.computed) {
        const key = evalNode(node.property, scope);
        return (obj as Record<string, unknown>)[String(key)];
      }
      return (obj as Record<string, unknown>)[node.property.name];
    }
    case "UnaryExpression": {
      const arg = evalNode(node.argument, scope);
      if (node.operator === "!") return !arg;
      if (node.operator === "-") return -(arg as number);
      if (node.operator === "+") return +(arg as number);
      throw new Error(`Unsupported unary operator: ${node.operator}`);
    }
    case "BinaryExpression":
    case "LogicalExpression": {
      const fn = BINARY[node.operator];
      if (!fn) throw new Error(`Unsupported binary operator: ${node.operator}`);
      const left = evalNode(node.left, scope);
      // Short-circuit
      if (node.operator === "&&" && !left) return false;
      if (node.operator === "||" && left) return true;
      const right = evalNode(node.right, scope);
      return fn(left, right);
    }
    default:
      throw new Error(`Unsupported expression node: ${node.type}`);
  }
}

/**
 * Compile a where-expression. Returns a predicate function that takes
 * an event and returns a boolean. Throws at compile time if the
 * expression uses disallowed syntax.
 */
export function compileCondition(expr: string): (event: Record<string, unknown>) => boolean {
  if (!expr || !expr.trim()) return () => true;
  const ast = jsep(expr);
  // Pre-walk validates that the AST is all supported shape
  validate(ast);
  return (event) => Boolean(evalNode(ast, event));
}

function validate(node: Ast): void {
  switch (node.type) {
    case "Literal":
    case "Identifier":
      return;
    case "MemberExpression":
      validate(node.object);
      if (node.computed) validate(node.property);
      return;
    case "UnaryExpression":
      validate(node.argument);
      return;
    case "BinaryExpression":
    case "LogicalExpression":
      validate(node.left);
      validate(node.right);
      return;
    default:
      throw new Error(`Disallowed expression node: ${node.type}`);
  }
}
