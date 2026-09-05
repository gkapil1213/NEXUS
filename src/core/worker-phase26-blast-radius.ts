export interface DependencyGraph {
  nodes: string[];
  edges: Record<string, string[]>;
}

export function calculateBlastRadius(graph: DependencyGraph, affectedNode: string): number {
  const visited = new Set<string>();
  const dfs = (node: string) => {
    if (visited.has(node)) return;
    visited.add(node);
    for (const dep of graph.edges[node] ?? []) dfs(dep);
  };
  dfs(affectedNode);
  return visited.size;
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
