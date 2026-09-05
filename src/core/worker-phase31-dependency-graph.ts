export interface DependencyGraph {
  nodes: string[];
  edges: Record<string, string[]>;
}

export function validateGraph(graph: DependencyGraph): { valid: boolean; reason: string } {
  for (const node of graph.nodes) {
    for (const dep of graph.edges[node] ?? []) {
      if (!graph.nodes.includes(dep)) return { valid: false, reason: `missing dependency ${dep}` };
    }
  }
  return { valid: true, reason: 'OK' };
}
