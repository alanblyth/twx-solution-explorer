import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SecurityModel, entityPermissionRows, refKey } from '../apps/explorer/src/app/security-model.ts';

// Shapes as ThingWorx 10.2.1 returns them (read on twx-dev).
const model = new SecurityModel({
  organizations: [
    { name: 'Everyone', connections: [{ from: '', to: 'Everyone' }], organizationalUnits: { Everyone: { name: 'Everyone', members: [{ name: 'Users', type: 'Group' }] } } },
    { name: 'Acme', description: 'The company', connections: [{ from: '', to: 'Acme' }, { from: 'Acme', to: 'EMEA' }, { from: 'EMEA', to: 'UK' }],
      organizationalUnits: { Acme: { name: 'Acme', members: [] }, EMEA: { name: 'EMEA', members: [] }, UK: { name: 'UK', members: [{ name: 'App.Operators', type: 'Group' }] } } },
  ],
  groups: [
    { name: 'Users', members: [{ name: 'alice', type: 'User' }, { name: 'System', type: 'User' }] },
    { name: 'App.Operators', members: [{ name: 'alice', type: 'User' }] },
  ],
  roles: [{ name: 'App.Role.Operator', members: { Group: { 'App.Operators': {} }, PermissionGroup: { 'App.PG.Role.Operator': {} } } }],
  permissionGroups: [
    { name: 'App.PG.Role.Operator', members: { PermissionGroup: { 'App.PG.Facade': {} } }, entityPermissions: {} },
    { name: 'App.PG.Facade', members: {}, entityPermissions: {
      Thing: { 'App.Api': { onEntity: { RunTime: { ServiceInvoke: { GetFleet: { isPermitted: true } } }, Visibility: { Visibility: { isPermitted: true } } } } },
      ThingTemplate: { 'App.TT': { onInstances: { RunTime: { PropertyRead: { name: { isPermitted: false } } } } } },
      Things: { '*': { onEntity: { DesignTime: { Create: { isPermitted: true } } } } },
    } },
  ],
}, ['alice', 'bob', 'System']);

test('organisation units form a tree from the connections', () => {
  assert.deepEqual(model.namesOf('OrganizationalUnit'), ['Acme:Acme', 'Acme:EMEA', 'Acme:UK', 'Everyone:Everyone']);
  assert.deepEqual(model.direct({ kind: 'OrganizationalUnit', name: 'Acme:EMEA' }, 'down').map((link) => [refKey(link.to), link.relation]), [['OrganizationalUnit:Acme:UK', 'sub-unit']]);
  assert.deepEqual(model.direct({ kind: 'Organization', name: 'Acme' }, 'down').map((link) => refKey(link.to)), ['OrganizationalUnit:Acme:Acme']);
  assert.equal(model.description({ kind: 'Organization', name: 'Acme' }), 'The company');
});

test('what holds a user, and what reaches it through roles', () => {
  const alice = { kind: 'User' as const, name: 'alice' };
  assert.deepEqual(model.transitive(alice, 'up').map(refKey), [
    'Group:App.Operators', 'Group:Users', 'Organization:Acme', 'Organization:Everyone',
    'OrganizationalUnit:Acme:Acme', 'OrganizationalUnit:Acme:EMEA', 'OrganizationalUnit:Acme:UK', 'OrganizationalUnit:Everyone:Everyone', 'Role:App.Role.Operator',
  ]);
  assert.deepEqual(model.throughRoles(alice).map(refKey), ['PermissionGroup:App.PG.Facade', 'PermissionGroup:App.PG.Role.Operator']);
  assert.deepEqual(model.throughRoles({ kind: 'PermissionGroup', name: 'App.PG.Facade' }).map(refKey), ['Group:App.Operators', 'User:alice']);
  assert.deepEqual(model.throughRoles({ kind: 'User', name: 'bob' }), []);
  assert.ok(model.has({ kind: 'User', name: 'bob' }));
});

test('a neighbourhood walks up and down to the chosen depth and stops at the limit', () => {
  const role = { kind: 'Role' as const, name: 'App.Role.Operator' };
  const near = model.neighbourhood(role, 1, 1);
  assert.deepEqual(near.links.map((link) => `${link.from.name}>${link.to.name}`).sort(), ['App.Role.Operator>App.Operators', 'App.Role.Operator>App.PG.Role.Operator']);
  const deep = model.neighbourhood(role, 1, 3);
  assert.ok(deep.links.some((link) => link.to.name === 'App.PG.Facade'));
  assert.ok(deep.links.some((link) => link.to.name === 'alice'));
  assert.equal(model.neighbourhood(role, 1, 3, 2).truncated, true);
  assert.ok(model.overview().links.some((link) => link.relation === 'sub-unit'));
});

test('a permission group\'s entity permissions become rows', () => {
  assert.deepEqual(entityPermissionRows(undefined), []);
  const facade = model.entityPermissions({ kind: 'PermissionGroup', name: 'App.PG.Facade' });
  assert.deepEqual(facade.map((row) => [row.entityType, row.entityName, row.scope, row.category, row.permission, row.resource, row.permitted]), [
    ['Thing', 'App.Api', 'entity', 'RunTime', 'ServiceInvoke', 'GetFleet', true],
    ['Thing', 'App.Api', 'entity', 'Visibility', 'Visibility', '', true],
    ['Things', '*', 'entity', 'DesignTime', 'Create', '', true],
    ['ThingTemplate', 'App.TT', 'instances', 'RunTime', 'PropertyRead', 'name', false],
  ]);
});
