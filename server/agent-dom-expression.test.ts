import { expect, it } from "vitest";
import { validateInspectionExpression } from "./agent-dom-expression";

it.each([
  "document.title",
  "document.querySelector('input').value",
  "({one: 1, two: [2,3]})",
  "/*leading*/ (1 + 2) // trailing comment",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: this is parser input, not host interpolation.
  "`hello ${1 + 2}`",
  "/a[)]b/i.test('a)b')",
  "({['\\u0061']: '\\u2028'})",
  "(()=>{ const a=1;return a+2; })()",
])("accepts a complete expression: %s", (source) =>
  expect(validateInspectionExpression(source)).toBe(source),
);

it.each([
  "",
  "document.title; document.body",
  "1); return 'escaped'; (1",
  "1); globalThis.bad=1; (1",
  "document.title) // escape",
  "await document.title",
  "import('https://example.invalid/')",
  "import.meta",
  "const secret='never echo me'",
  "1;",
  "1 /* unclosed",
  "x".repeat(8193),
])("refuses trailing tokens, statements, escapes or modules (%#)", (source) => {
  expect(() => validateInspectionExpression(source)).toThrow(
    "one complete synchronous JavaScript expression",
  );
});
