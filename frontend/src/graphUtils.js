import dagre from 'dagre';

const DEFAULT_ARROW_MARKER = 'arrowclosed';

// node sizes need to match what's defined in styles.css
// if you change one you have to change both - yes this is annoying
const FILE_NODE_WIDTH = 238;
const FILE_NODE_HEIGHT = 120;
const FLOW_NODE_WIDTH = 270;
const FLOW_NODE_HEIGHT = 150;

/**
 * Use dagre to compute a left-to-right hierarchical layout driven by
 * dependency edges.  Disconnected nodes are still positioned sensibly
 * because dagre handles disconnected components internally.
 */
export function layoutWithDagre(
  nodes,
  edges,
  nodeWidth = FILE_NODE_WIDTH,
  nodeHeight = FILE_NODE_HEIGHT,
) {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  // LR = left-to-right, which maps naturally to "source imports target"
  // tried TB (top-to-bottom) first but it looked like a family tree, not code
  g.setGraph({
    rankdir: 'LR',
    nodesep: 55,
    ranksep: 220,
    marginx: 40,
    marginy: 40,
  });

  nodes.forEach((node) => {
    g.setNode(node.id, { width: nodeWidth, height: nodeHeight });
  });

  edges.forEach((edge) => {
    if (g.hasNode(edge.source) && g.hasNode(edge.target)) {
      g.setEdge(edge.source, edge.target);
    }
  });

  dagre.layout(g);

  return nodes.map((node) => {
    const pos = g.node(node.id);
    return {
      ...node,
      position: {
        x: pos.x - nodeWidth / 2,
        y: pos.y - nodeHeight / 2,
      },
    };
  });
}

export function prepareDetailedGraph(data, arrowMarker = DEFAULT_ARROW_MARKER) {
  const relationshipCounts = getRelationshipCounts(data.edges);
  const enrichedNodes = data.nodes.map((node) => ({
    ...node,
    data: {
      ...node.data,
      kind: 'file',
      incomingCount: relationshipCounts.incoming.get(node.id) ?? 0,
      outgoingCount: relationshipCounts.outgoing.get(node.id) ?? 0,
    },
  }));
  const styledEdges = data.edges.map((edge) =>
    buildEdge(edge, 'imports', false, arrowMarker),
  );
  return {
    nodes: layoutWithDagre(enrichedNodes, styledEdges, FILE_NODE_WIDTH, FILE_NODE_HEIGHT),
    edges: styledEdges,
  };
}

export function prepareSimplifiedGraph(data, arrowMarker = DEFAULT_ARROW_MARKER) {
  // 40 is a reasonable cutoff - below that the per-file view is still readable,
  // above that you just get a wall of nodes. tuned by looking at a few real repos.
  if (data.nodes.length <= 40) {
    return prepareFileFlowGraph(data, arrowMarker);
  }

  const groups = new Map();
  data.nodes.forEach((node) => {
    const folder = node.data.folder || 'root';
    if (!groups.has(folder)) {
      groups.set(folder, {
        id: `group:${folder}`,
        label: folder,
        folder,
        fileCount: 0,
        loc: 0,
        complexity: 0,
      });
    }
    const group = groups.get(folder);
    group.fileCount += 1;
    group.loc += node.data.loc;
    group.complexity = Math.max(group.complexity, node.data.complexity);
  });

  const folderByFile = new Map(data.nodes.map((node) => [node.id, node.data.folder || 'root']));
  const edgeGroups = new Map();
  data.edges.forEach((edge) => {
    const sourceFolder = folderByFile.get(edge.source);
    const targetFolder = folderByFile.get(edge.target);
    if (!sourceFolder || !targetFolder || sourceFolder === targetFolder) return;
    const key = `${sourceFolder}->${targetFolder}`;
    const existing = edgeGroups.get(key) ?? {
      source: `group:${sourceFolder}`,
      target: `group:${targetFolder}`,
      sourceLabel: sourceFolder,
      targetLabel: targetFolder,
      count: 0,
    };
    existing.count += 1;
    edgeGroups.set(key, existing);
  });

  const edges = [...edgeGroups.values()].map((edge) =>
    buildEdge(
      {
        id: `${edge.source}->${edge.target}`,
        source: edge.source,
        target: edge.target,
        data: { sourceLabel: edge.sourceLabel, targetLabel: edge.targetLabel },
      },
      `${edge.count} import${edge.count === 1 ? '' : 's'}`,
      true,
      arrowMarker,
    ),
  );
  const relationshipCounts = getRelationshipCounts(edges);
  const sortedGroups = [...groups.values()].sort((a, b) => a.label.localeCompare(b.label));

  const groupNodes = sortedGroups.map((group) => ({
    id: group.id,
    type: 'flowNode',
    data: {
      ...group,
      kind: 'group',
      subtitle: `${group.fileCount} files in this area`,
      description: `${group.label} contains ${group.fileCount} files and ${group.loc} lines of code.`,
      incomingCount: relationshipCounts.incoming.get(group.id) ?? 0,
      outgoingCount: relationshipCounts.outgoing.get(group.id) ?? 0,
    },
  }));

  return {
    nodes: layoutWithDagre(groupNodes, edges, FLOW_NODE_WIDTH, FLOW_NODE_HEIGHT),
    edges,
  };
}

export function prepareFileFlowGraph(data, arrowMarker = DEFAULT_ARROW_MARKER) {
  const relationshipCounts = getRelationshipCounts(data.edges);
  const flowNodes = data.nodes.map((node) => ({
    id: node.id,
    type: 'flowNode',
    data: {
      ...node.data,
      kind: 'file',
      label: node.data.label,
      subtitle: node.data.path,
      description: `${node.data.path} is a file-level flowchart node. Click it to get an AI summary and see its imports.`,
      incomingCount: relationshipCounts.incoming.get(node.id) ?? 0,
      outgoingCount: relationshipCounts.outgoing.get(node.id) ?? 0,
    },
  }));
  const styledEdges = data.edges.map((edge) =>
    buildEdge(edge, 'imports', true, arrowMarker),
  );
  return {
    nodes: layoutWithDagre(flowNodes, styledEdges, FLOW_NODE_WIDTH, FLOW_NODE_HEIGHT),
    edges: styledEdges,
  };
}

export function buildEdge(edge, label, simplified = false, arrowMarker = DEFAULT_ARROW_MARKER) {
  return {
    ...edge,
    animated: !simplified,
    type: 'smoothstep',
    label,
    markerEnd: { type: arrowMarker, color: simplified ? '#2563eb' : '#475569' },
    style: { stroke: simplified ? '#2563eb' : '#475569', strokeWidth: simplified ? 2.6 : 2 },
    labelStyle: { fill: simplified ? '#1d4ed8' : '#334155', fontSize: 11, fontWeight: 700 },
    labelBgStyle: { fill: '#ffffff', fillOpacity: 0.9 },
  };
}

export function getRelationshipCounts(edges) {
  const incoming = new Map();
  const outgoing = new Map();
  edges.forEach((edge) => {
    incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1);
    outgoing.set(edge.source, (outgoing.get(edge.source) ?? 0) + 1);
  });
  return { incoming, outgoing };
}

export function getRelationships(edges, selectedId) {
  if (!selectedId) {
    return {
      incoming: [],
      outgoing: edges.slice(0, 12),
    };
  }
  return {
    incoming: edges.filter((edge) => edge.target === selectedId),
    outgoing: edges.filter((edge) => edge.source === selectedId),
  };
}
