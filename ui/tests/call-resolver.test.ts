import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CallResolver, countNodes } from '../apps/explorer/src/app/call-resolver.ts';

const script = (code: string) => ({ handlerName: 'Script', configurationTables: { Script: { rows: [{ code }] } } });
const entities: Record<string, any> = {
  'Things/A': {
    thingTemplate: 'T',
    thingShape: { serviceImplementations: { Main: script('Things["B"].Work(); me.Inherited(); Things["Gone"].X(); Resources["EntityServices"].GetEntityList();'), Loop: script('Things["A"].Loop();') }, serviceDefinitions: {} },
    effectiveShape: { serviceDefinitions: { Main: { sourceType: 'Unknown' }, Inherited: { sourceType: 'ThingTemplate', sourceName: 'T' }, GetPropertyValues: { sourceType: 'ThingPackage', sourceName: 'ConfiguredThing' } } },
  },
  'Things/B': {
    thingShape: { serviceImplementations: { Work: script('Things["A"].GetPropertyValues(); Things["B"].Java();'), Java: { handlerName: 'JavaMethod' } } },
    effectiveShape: { serviceDefinitions: { Work: { sourceType: 'Unknown' }, Java: { sourceType: 'Unknown' } } },
  },
  'ThingTemplates/T': { thingShape: { serviceImplementations: { Inherited: script('Things["B"].Work();') } } },
};
const fetcher = async (collection: string, name: string) => entities[`${collection}/${name}`] ?? null;
const options = { maxDepth: 6 };

test('resolves calls into a tree with leaves for builtin, java, platform, missing', async () => {
  const tree = await new CallResolver(fetcher).resolve({ collection: 'Things', name: 'A' }, 'Main', options);
  const calls = tree.steps.map((s: any) => `${s.callee.entity.name}.${s.callee.service}:${s.callee.kind}`);
  assert.deepEqual(calls, ['B.Work:script', 'A.Inherited:script', 'Gone.X:missing', 'EntityServices.GetEntityList:platform']);
  const work = (tree.steps[0] as any).callee;
  assert.deepEqual(work.steps.map((s: any) => s.callee.kind), ['builtin', 'java']);
});

test('an inherited service is read from the template and me stays the original thing', async () => {
  const tree = await new CallResolver(fetcher).resolve({ collection: 'Things', name: 'A' }, 'Main', options);
  const inherited = (tree.steps[1] as any).callee;
  assert.equal(inherited.implementedBy.name, 'T');
});

test('recursion is cut and the depth limit is reported', async () => {
  const resolver = new CallResolver(fetcher);
  const loop = await resolver.resolve({ collection: 'Things', name: 'A' }, 'Loop', options);
  assert.equal((loop.steps[0] as any).callee.kind, 'recursive');
  const limited = await resolver.resolve({ collection: 'Things', name: 'A' }, 'Main', { maxDepth: 1 });
  assert.equal((limited.steps[0] as any).callee.kind, 'limit');
});

test('lists own services before inherited and builtin', async () => {
  const list = await new CallResolver(fetcher).listServices({ collection: 'Things', name: 'A' });
  assert.deepEqual(list.map((s) => `${s.name}:${s.origin}`), ['Loop:own', 'Main:own', 'Inherited:inherited', 'GetPropertyValues:builtin']);
});

test('counts distinct services', async () => {
  const tree = await new CallResolver(fetcher).resolve({ collection: 'Things', name: 'A' }, 'Main', options);
  assert.ok(countNodes(tree) >= 5);
});
