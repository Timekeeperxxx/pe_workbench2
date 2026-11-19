export const CONTEXT_BUDGET_FAILURE = "上下文超限，没有生成回答。";

export function isContextBudgetError(errorMessage) {
  const text = String(errorMessage || "");
  if (text.includes(CONTEXT_BUDGET_FAILURE)) return true;
  return /maximum context length|reduce the length of the messages|exceeds the context window/i.test(text);
}
