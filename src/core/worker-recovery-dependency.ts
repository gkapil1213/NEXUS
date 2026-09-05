export interface DependencyGraph {
  nodes: string[];
  edges: Record<string, string[]>;
}

export function detectCycle(graph: DependencyGraph): boolean {
  const visited = new Set<string>();
  const stack = new Set<string>();
  const dfs = (node: string): boolean => {
    visited.add(node); stack.add(node);
    for (const dep of graph.edges[node] ?? []) {
      if (stack.has(dep)) return true;
      if (!visited.has(dep) && dfs(dep)) return true;
    }
    stack.delete(node);
    return false;
  };
  for (const node of graph.nodes) if (!visited.has(node) && dfs(node)) return true;
  return false;
}

export function orderDependencies(graph: DependencyGraph): string[] {
  const result: string[] = [];
  const visited = new Set<string>();
  const visit = (node: string) => {
    if (visited.has(node)) return;
    visited.add(node);
    for (const dep of graph.edges[node] ?? []) visit(dep);
    result.push(node);
  };
  for (const node of graph.nodes) visit(node);
  return result;
}
