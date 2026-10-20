import { parseExpressionAt, tokenizer, tokTypes } from "acorn";

/** Whole-input grammar validation keeps source inside the fixed result serializer. */
export function validateInspectionExpression(source: string): string {
  try {
    if (source.length === 0 || source.length > 8192) throw new Error();
    const options = {
      ecmaVersion: 2024 as const,
      sourceType: "script" as const,
      preserveParens: true,
      allowHashBang: false,
    };
    const expression = parseExpressionAt(source, 0, options);
    if (tokenizer(source.slice(expression.end), options).getToken().type !== tokTypes.eof)
      throw new Error();
    const pending: unknown[] = [expression];
    let nodes = 0;
    while (pending.length) {
      if (++nodes > 4096) throw new Error();
      const value = pending.pop();
      if (!value || typeof value !== "object") continue;
      const node = value as Record<string, unknown>;
      if (["ImportExpression", "AwaitExpression", "MetaProperty"].includes(String(node.type)))
        throw new Error();
      for (const child of Object.values(node)) {
        if (Array.isArray(child)) pending.push(...child);
        else if (child && typeof child === "object") pending.push(child);
      }
    }
    return source;
  } catch {
    // Parser messages can contain source text; do not echo it into the tool result.
    throw new Error("Inspection requires one complete synchronous JavaScript expression");
  }
}
