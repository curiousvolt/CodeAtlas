import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import ReactFlow, {
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlowProvider,
  applyEdgeChanges,
  applyNodeChanges,
} from 'reactflow';
import 'reactflow/dist/style.css';
import './styles.css';
import {
  getRelationships,
  prepareDetailedGraph,
  prepareSimplifiedGraph,
} from './graphUtils';

const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://127.0.0.1:8000';

/* ─── Skeleton Components ─── */

function SkeletonLine({ width = '100%' }) {
  return <div className="skeleton-line" style={{ width }} />;
}

function SkeletonBlock({ lines = 3 }) {
  const widths = ['92%', '80%', '65%', '50%'];
  return (
    <div className="skeleton-group">
      {Array.from({ length: lines }, (_, i) => (
        <SkeletonLine key={i} width={widths[i % widths.length]} />
      ))}
    </div>
  );
}

/* ─── Node Components ─── */

function FileNode({ data }) {
  const risk = data.complexity > 12 || data.loc > 300 ? 'high' : data.complexity > 6 || data.loc > 120 ? 'medium' : 'low';

  return (
    <div className={`file-node file-node-${risk}${data.dimmed ? ' node-dimmed' : ''}`}>
      <Handle className="node-handle node-handle-target" type="target" position={Position.Left} />
      <div className="file-node-top">
        <span className="file-name">{data.label}</span>
        <span className="file-ext">{data.extension || 'file'}</span>
      </div>
      <div className="file-path">{data.folder}</div>
      <div className="file-metrics">
        <span>{data.loc} LoC</span>
        <span>Cx {data.complexity}</span>
        <span>{data.outgoingCount ?? 0} out</span>
        <span>{data.incomingCount ?? 0} in</span>
      </div>
      <Handle className="node-handle node-handle-source" type="source" position={Position.Right} />
    </div>
  );
}

function FlowNode({ data }) {
  return (
    <div className={`flow-node${data.dimmed ? ' node-dimmed' : ''}`}>
      <Handle className="node-handle node-handle-target" type="target" position={Position.Left} />
      <div className="flow-node-title">{data.label}</div>
      <div className="flow-node-subtitle">{data.subtitle}</div>
      <div className="flow-node-metrics">
        <span>{data.loc} LoC</span>
        <span>{data.outgoingCount ?? 0} outgoing</span>
        <span>{data.incomingCount ?? 0} incoming</span>
      </div>
      <Handle className="node-handle node-handle-source" type="source" position={Position.Right} />
    </div>
  );
}

const nodeTypes = { fileNode: FileNode, flowNode: FlowNode };

/* ─── Main Application ─── */

function App() {
  const [repoPath, setRepoPath] = useState('');
  const [mapData, setMapData] = useState(null);
  const [nodes, setNodes] = useState([]);
  const [edges, setEdges] = useState([]);
  const [selectedNode, setSelectedNode] = useState(null);
  const [summary, setSummary] = useState(null);
  const [viewMode, setViewMode] = useState('detailed');
  const [loadingMap, setLoadingMap] = useState(false);
  const [loadingSummary, setLoadingSummary] = useState(false);
  const [error, setError] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  // check localStorage first, then fall back to system preference
  // doing this in the useState initializer avoids a flash of wrong theme on load
  const [darkMode, setDarkMode] = useState(() => {
    try {
      const stored = localStorage.getItem('repo-viz-theme');
      if (stored) return stored === 'dark';
    } catch { /* ignore */ }
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
  });

  /* Apply dark mode to document root */
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', darkMode ? 'dark' : 'light');
    try {
      localStorage.setItem('repo-viz-theme', darkMode ? 'dark' : 'light');
    } catch { /* ignore */ }
  }, [darkMode]);

  /* Fetch the repository map */
  const loadMap = useCallback(async () => {
    setLoadingMap(true);
    setError('');
    try {
      const query = repoPath.trim() ? `?root=${encodeURIComponent(repoPath.trim())}` : '';
      const response = await fetch(`${API_BASE}/api/map${query}`);
      if (!response.ok) throw new Error(await response.text());
      const data = await response.json();
      setMapData(data);
      setRepoPath(data.root);
      setSelectedNode(null);
      setSummary(null);
      setSearchQuery('');
    } catch (err) {
      setError(err.message || 'Failed to load repository map.');
    } finally {
      setLoadingMap(false);
    }
  }, [repoPath]);

  /* Load default map on mount — intentionally ignores loadMap dep to only run once */
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { loadMap(); }, []);

  /* Build graph nodes/edges when data or view mode changes */
  useEffect(() => {
    if (!mapData) return;
    const graph =
      viewMode === 'simple'
        ? prepareSimplifiedGraph(mapData, MarkerType.ArrowClosed)
        : prepareDetailedGraph(mapData, MarkerType.ArrowClosed);
    setNodes(graph.nodes);
    setEdges(graph.edges);
    setSelectedNode(null);
    setSummary(null);
  }, [mapData, viewMode]);

  /* Search filtering: dim non-matching nodes */
  const displayNodes = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return nodes;
    return nodes.map((node) => ({
      ...node,
      data: {
        ...node.data,
        dimmed: !(
          node.data.label?.toLowerCase().includes(query) ||
          node.data.path?.toLowerCase().includes(query) ||
          node.data.folder?.toLowerCase().includes(query)
        ),
      },
    }));
  }, [nodes, searchQuery]);

  const searchMatchCount = useMemo(() => {
    if (!searchQuery.trim()) return null;
    return displayNodes.filter((n) => !n.data.dimmed).length;
  }, [displayNodes, searchQuery]);

  const onNodesChange = useCallback(
    (changes) => setNodes((current) => applyNodeChanges(changes, current)),
    [],
  );
  const onEdgesChange = useCallback(
    (changes) => setEdges((current) => applyEdgeChanges(changes, current)),
    [],
  );

  /* Click a node to fetch its AI summary */
  const onNodeClick = useCallback(
    async (_, node) => {
      setSelectedNode(node);
      setSummary(null);
      if (node.data.kind === 'group') {
        setLoadingSummary(false);
        setError('');
        return;
      }
      setLoadingSummary(true);
      setError('');
      try {
        const response = await fetch(`${API_BASE}/api/summary`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: node.data.path, repoPath: mapData?.root }),
        });
        if (!response.ok) throw new Error(await response.text());
        setSummary(await response.json());
      } catch (err) {
        setError(err.message || 'Failed to summarize file.');
      } finally {
        setLoadingSummary(false);
      }
    },
    [mapData?.root],
  );

  const stats = mapData?.stats;

  const miniMapNodeColor = useCallback((node) => {
    if (node.data.complexity > 12 || node.data.loc > 300) return '#ef4444';
    if (node.data.complexity > 6 || node.data.loc > 120) return '#f59e0b';
    return '#22c55e';
  }, []);

  const selectedMetrics = useMemo(() => selectedNode?.data ?? null, [selectedNode]);
  // TODO: cap incoming/outgoing list at some point - if a file is imported by 50
  // others the panel gets huge. for now most repos don't hit that
  const relationships = useMemo(
    () => getRelationships(edges, selectedNode?.id),
    [edges, selectedNode?.id],
  );

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-block">
          <h1>Repository Visualizer</h1>
          <p>Interactive dependency map with file metrics and cached summaries.</p>
        </div>
        <form
          className="path-form"
          onSubmit={(event) => {
            event.preventDefault();
            loadMap();
          }}
        >
          <input
            aria-label="Repository path"
            value={repoPath}
            onChange={(event) => setRepoPath(event.target.value)}
            placeholder="Repository path"
          />
          <button type="submit" disabled={loadingMap}>
            {loadingMap ? 'Scanning\u2026' : 'Scan'}
          </button>
          <button
            className={`mode-button ${viewMode === 'simple' ? 'mode-button-active' : ''}`}
            type="button"
            onClick={() => setViewMode((current) => (current === 'simple' ? 'detailed' : 'simple'))}
            disabled={!mapData}
          >
            {viewMode === 'simple' ? 'Detailed' : 'Simplify'}
          </button>
          <button
            className="theme-toggle"
            type="button"
            onClick={() => setDarkMode((d) => !d)}
            aria-label="Toggle dark mode"
          >
            {darkMode ? '\u2600\uFE0F' : '\uD83C\uDF19'}
          </button>
        </form>
      </header>

      <main className="workspace">
        <section className="graph-region">
          <div className="stats-strip">
            {loadingMap ? (
              Array.from({ length: 4 }, (_, i) => (
                <div key={i} className="metric">
                  <SkeletonLine width="50%" />
                  <SkeletonLine width="70%" />
                </div>
              ))
            ) : (
              <>
                <Metric label="Files" value={stats?.files ?? 0} />
                <Metric label="Imports" value={stats?.dependencies ?? 0} />
                <Metric label="Total LoC" value={stats?.totalLoc ?? 0} />
                <Metric
                  label={viewMode === 'simple' ? 'View' : 'Max Cx'}
                  value={viewMode === 'simple' ? 'Flowchart' : stats?.maxComplexity ?? 0}
                />
              </>
            )}
          </div>
          <div className="flow-frame">
            <div className="graph-search">
              <span className="search-icon">{'\uD83D\uDD0D'}</span>
              <input
                placeholder="Search files\u2026"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Escape' && setSearchQuery('')}
                aria-label="Search files"
              />
              {searchQuery && (
                <>
                  {searchMatchCount !== null && (
                    <span className="search-count">{searchMatchCount} found</span>
                  )}
                  <button
                    className="search-clear"
                    onClick={() => setSearchQuery('')}
                    aria-label="Clear search"
                    type="button"
                  >
                    ✕
                  </button>
                </>
              )}
            </div>
            <ReactFlow
              nodes={displayNodes}
              edges={edges}
              nodeTypes={nodeTypes}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onNodeClick={onNodeClick}
              fitView
              fitViewOptions={{ padding: 0.15 }}
              minZoom={0.08}
              maxZoom={2}
              deleteKeyCode={null}
            >
              <Background color={darkMode ? '#2d3140' : '#d2d8e2'} gap={18} />
              <Controls />
              <MiniMap nodeColor={miniMapNodeColor} pannable zoomable />
            </ReactFlow>
          </div>
        </section>

        <aside className="side-panel">
          <div>
            <h2>
              {selectedMetrics
                ? selectedMetrics.label
                : viewMode === 'simple'
                  ? 'Simplified Flowchart'
                  : 'Select a file'}
            </h2>
            <p className="muted">
              {selectedMetrics
                ? selectedMetrics.description || selectedMetrics.path
                : viewMode === 'simple'
                  ? 'This view groups files by folder and shows the main import flow between areas.'
                  : 'Click a node to inspect metrics and request a cached AI summary.'}
            </p>
          </div>

          {selectedMetrics && (
            <div className="detail-grid">
              <Metric
                label={selectedMetrics.kind === 'group' ? 'Area' : 'Folder'}
                value={selectedMetrics.folder || selectedMetrics.label}
              />
              <Metric
                label={selectedMetrics.kind === 'group' ? 'Files' : 'LoC'}
                value={selectedMetrics.kind === 'group' ? selectedMetrics.fileCount : selectedMetrics.loc}
              />
              <Metric
                label={selectedMetrics.kind === 'group' ? 'Total LoC' : 'Complexity'}
                value={selectedMetrics.kind === 'group' ? selectedMetrics.loc : selectedMetrics.complexity}
              />
              <Metric
                label={selectedMetrics.kind === 'group' ? 'Max Cx' : 'Type'}
                value={selectedMetrics.kind === 'group' ? selectedMetrics.complexity : selectedMetrics.extension || 'file'}
              />
              <Metric label="Imports" value={selectedMetrics.outgoingCount ?? 0} />
              <Metric label="Imported By" value={selectedMetrics.incomingCount ?? 0} />
            </div>
          )}

          <RelationshipPanel
            incoming={relationships.incoming}
            outgoing={relationships.outgoing}
            selectedPath={selectedMetrics?.path || selectedMetrics?.label}
          />

          <div className="summary-block">
            <h3>Summary</h3>
            {loadingSummary && <SkeletonBlock lines={4} />}
            {!loadingSummary && summary && (
              <>
                <p>{summary.summary}</p>
                <span className="summary-meta">
                  {summary.cached ? 'Cached' : 'Fresh'} | {summary.provider} | {summary.model}
                </span>
              </>
            )}
            {!loadingSummary && !summary && selectedMetrics?.kind === 'group' && (
              <p className="muted">
                Simplified group nodes summarize a folder or module. Switch to Detailed mode and click an individual
                file for an AI explanation.
              </p>
            )}
            {!loadingSummary && !summary && !selectedMetrics && (
              <p className="muted">No file selected yet.</p>
            )}
          </div>

          {error && <div className="error-box">{error}</div>}
        </aside>
      </main>
    </div>
  );
}

/* ─── Subcomponents ─── */

function RelationshipPanel({ incoming, outgoing, selectedPath }) {
  const emptyText = selectedPath ? 'No relationships found for this file.' : 'Scan results will appear here.';
  const hasRelationships = incoming.length > 0 || outgoing.length > 0;

  return (
    <div className="relationships-block">
      <h3>{selectedPath ? 'Relationships' : 'Detected Relationships'}</h3>
      {!hasRelationships && <p className="muted">{emptyText}</p>}
      {outgoing.length > 0 && (
        <RelationshipList
          title={selectedPath ? 'Imports' : 'Imports Found'}
          edges={outgoing}
          direction="outgoing"
        />
      )}
      {incoming.length > 0 && (
        <RelationshipList title="Imported By" edges={incoming} direction="incoming" />
      )}
    </div>
  );
}

function RelationshipList({ title, edges, direction }) {
  return (
    <div className="relationship-list">
      <h4>{title}</h4>
      <ul>
        {edges.map((edge) => (
          <li key={`${direction}-${edge.id}`}>
            <span className="relationship-source">{edge.data?.sourceLabel ?? edge.source}</span>
            <span className="relationship-arrow">-&gt;</span>
            <span className="relationship-target">{edge.data?.targetLabel ?? edge.target}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Metric({ label, value }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

/* ─── Mount ─── */

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ReactFlowProvider>
      <App />
    </ReactFlowProvider>
  </React.StrictMode>,
);
