import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getRelationships,
  prepareDetailedGraph,
  prepareSimplifiedGraph,
} from './graphUtils.js';

function node(id, folder, overrides = {}) {
  return {
    id,
    type: 'fileNode',
    data: {
      label: id.split('/').at(-1),
      path: id,
      folder,
      extension: '.js',
      loc: 10,
      complexity: 2,
      ...overrides,
    },
  };
}

test('prepareDetailedGraph adds relationship counts and dagre-computed positions', () => {
  const data = {
    nodes: [
      node('src/app.js', 'src'),
      node('src/api.js', 'src'),
      node('shared/util.js', 'shared'),
    ],
    edges: [
      { id: 'src/app.js->src/api.js', source: 'src/app.js', target: 'src/api.js', label: 'imports' },
      { id: 'src/app.js->shared/util.js', source: 'src/app.js', target: 'shared/util.js', label: 'imports' },
    ],
  };

  const graph = prepareDetailedGraph(data);
  const appNode = graph.nodes.find((item) => item.id === 'src/app.js');
  const utilNode = graph.nodes.find((item) => item.id === 'shared/util.js');

  assert.equal(appNode.data.kind, 'file');
  assert.equal(appNode.data.outgoingCount, 2);
  assert.equal(appNode.data.incomingCount, 0);
  assert.equal(utilNode.data.incomingCount, 1);

  /* Dagre positions are algorithm-determined; verify they exist and are numeric */
  assert.equal(typeof appNode.position.x, 'number');
  assert.equal(typeof appNode.position.y, 'number');
  assert.ok(Number.isFinite(appNode.position.x));
  assert.ok(Number.isFinite(appNode.position.y));

  /* Source node (app) should be positioned to the left of targets (LR layout) */
  assert.ok(appNode.position.x < utilNode.position.x, 'Source node should be left of its dependency in LR layout');

  assert.equal(graph.edges[0].animated, true);
});

test('prepareSimplifiedGraph keeps small repositories as readable file flow nodes', () => {
  const data = {
    nodes: [node('a.js', 'root'), node('b.js', 'root')],
    edges: [{ id: 'a.js->b.js', source: 'a.js', target: 'b.js', label: 'imports' }],
  };

  const graph = prepareSimplifiedGraph(data);

  assert.equal(graph.nodes.length, 2);
  assert.equal(graph.nodes[0].type, 'flowNode');
  assert.equal(graph.nodes[0].data.kind, 'file');
  assert.equal(graph.edges[0].animated, false);
  assert.equal(graph.edges[0].label, 'imports');

  /* Verify dagre positions exist */
  assert.equal(typeof graph.nodes[0].position.x, 'number');
  assert.equal(typeof graph.nodes[0].position.y, 'number');
});

test('prepareSimplifiedGraph collapses larger repositories into folder groups', () => {
  const nodes = [];
  for (let index = 0; index < 25; index += 1) {
    nodes.push(node(`core/file-${index}.js`, 'core', { loc: 5 + index, complexity: 1 + (index % 4) }));
    nodes.push(node(`web/file-${index}.js`, 'web', { loc: 7 + index, complexity: 1 + (index % 5) }));
  }
  const data = {
    nodes,
    edges: [
      { id: 'core/file-0.js->web/file-0.js', source: 'core/file-0.js', target: 'web/file-0.js' },
      { id: 'core/file-1.js->web/file-1.js', source: 'core/file-1.js', target: 'web/file-1.js' },
      { id: 'web/file-2.js->core/file-2.js', source: 'web/file-2.js', target: 'core/file-2.js' },
    ],
  };

  const graph = prepareSimplifiedGraph(data);
  const core = graph.nodes.find((item) => item.id === 'group:core');
  const web = graph.nodes.find((item) => item.id === 'group:web');
  const coreToWeb = graph.edges.find((edge) => edge.source === 'group:core' && edge.target === 'group:web');

  assert.equal(graph.nodes.length, 2);
  assert.equal(core.data.kind, 'group');
  assert.equal(core.data.fileCount, 25);
  assert.equal(core.data.outgoingCount, 1);
  assert.equal(web.data.incomingCount, 1);
  assert.equal(coreToWeb.label, '2 imports');

  /* Verify dagre positions exist */
  assert.equal(typeof core.position.x, 'number');
  assert.equal(typeof core.position.y, 'number');
});

test('getRelationships returns selected incoming and outgoing edges', () => {
  const edges = [
    { id: 'a->b', source: 'a', target: 'b' },
    { id: 'b->c', source: 'b', target: 'c' },
    { id: 'd->b', source: 'd', target: 'b' },
  ];

  const relationships = getRelationships(edges, 'b');

  assert.deepEqual(
    relationships.incoming.map((edge) => edge.id),
    ['a->b', 'd->b'],
  );
  assert.deepEqual(
    relationships.outgoing.map((edge) => edge.id),
    ['b->c'],
  );
});
