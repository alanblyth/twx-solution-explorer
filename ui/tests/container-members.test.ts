import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ContainerMembers, containerMembersFor, memberNamesIn } from '../apps/explorer/src/app/container-members.ts';
import type { ContainerSource } from '../apps/explorer/src/app/container-members.ts';
import type { MemberEntity } from '../apps/explorer/src/app/extension-graph.ts';

function fakeSource(projects: Record<string, MemberEntity[]>, packages: Record<string, MemberEntity[]> = {}): ContainerSource & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    list: async (collection) => { calls.push(`list:${collection}`); return Object.keys(projects).map((name) => ({ name })); },
    packages: async () => { calls.push('packages'); return Object.keys(packages).map((name) => ({ name })); },
    projectEntities: async (name) => {
      calls.push(`project:${name}`);
      if (!projects[name]) throw new Error('403');
      return projects[name];
    },
    packageEntities: async (name) => { calls.push(`package:${name}`); return packages[name] ?? []; },
  };
}

test('members leave out the container itself and duplicates, and are read once unless fresh', async () => {
  const source = fakeSource({ CM: [{ name: 'CM', type: 'Project' }, { name: 'CM.A', type: 'Thing' }, { name: 'CM.A', type: 'Thing' }] });
  const containers = new ContainerMembers(source);
  assert.deepEqual(await containers.members('Project', 'CM'), [{ name: 'CM.A', type: 'Thing' }]);
  await containers.members('Project', 'CM');
  assert.equal(source.calls.filter((call) => call === 'project:CM').length, 1);
  await containers.members('Project', 'CM', true);
  assert.equal(source.calls.filter((call) => call === 'project:CM').length, 2);
});

test('extension members leave out the ExtensionPackage entity', async () => {
  const source = fakeSource({}, { Pack: [{ name: 'Pack', type: 'ExtensionPackage' }, { name: 'Pack.W', type: 'Widget' }] });
  assert.deepEqual(await new ContainerMembers(source).members('Extension', 'Pack'), [{ name: 'Pack.W', type: 'Widget' }]);
});

test('ownerMap maps entities of the other containers and skips unreadable ones', async () => {
  const source = fakeSource({ CM: [{ name: 'CM.A', type: 'Thing' }], Other: [{ name: 'O.T', type: 'ThingTemplate' }], Hidden: [] });
  const containers = new ContainerMembers({ ...source, projectEntities: (name) => (name === 'Hidden' ? Promise.reject(new Error('403')) : source.projectEntities(name)) });
  const progress: number[] = [];
  const owners = await containers.ownerMap('Project', 'CM', { onProgress: (done) => progress.push(done) });
  assert.deepEqual([...owners], [['ThingTemplate:O.T', 'Other']]);
  assert.equal(progress.at(-1), 2);
});

test('memberNamesIn keeps members of one REST collection', () => {
  const members = [{ name: 'A', type: 'Thing' }, { name: 'B', type: 'ThingTemplate' }, { name: 'C', type: 'Thing' }];
  assert.deepEqual([...memberNamesIn(members, 'Things')], ['A', 'C']);
  assert.deepEqual([...memberNamesIn(members, 'ThingTemplates')], ['B']);
});

test('containerMembersFor shares one instance per source', () => {
  const source = fakeSource({});
  assert.equal(containerMembersFor(source), containerMembersFor(source));
});
