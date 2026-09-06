export function resolveGeneratePrompt(
  node: { data?: { prompt?: unknown } },
  nodesById: Map<string, { data?: { text?: unknown } }>,
  incomingEdges: readonly { source: string; targetHandle?: string | null }[],
): string {
  const promptEdge = incomingEdges.find((edge) => edge.targetHandle === 'prompt');
  const promptSource = promptEdge ? nodesById.get(promptEdge.source) : undefined;
  const wiredPrompt = promptSource?.data?.text;
  if (typeof wiredPrompt === 'string' && wiredPrompt.trim()) return wiredPrompt;

  const fallbackPrompt = node.data?.prompt;
  return typeof fallbackPrompt === 'string' ? fallbackPrompt : '';
}
