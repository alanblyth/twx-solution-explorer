import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SecurityDirectory, grantedResources, runTimeGrants, serviceIssues, summariseAccess, visibilityGrants } from '../apps/explorer/src/app/permissions.ts';
import { ServiceCallIndex, UiUsageIndex, callsOfHolder, mashupServiceKeys, referencedScripts, scriptNamesService, serviceKey } from '../apps/explorer/src/app/service-usage.ts';
import { startTabOf } from '../apps/explorer/src/app/start-tab.ts';

// Shapes as ThingWorx 10.2.1 returns them (read on twx-dev).
const allow = (name: string, type: string) => ({ isPermitted: true, name, type });
const entry = (resourceName: string, invoke: any[]) => ({ resourceName, ServiceInvoke: invoke, PropertyRead: [], PropertyWrite: [], EventInvoke: [], EventSubscribe: [] });

const directory = new SecurityDirectory({
  groups: [
    { name: 'Users', members: [{ name: 'Administrator', type: 'User' }, { name: 'System', type: 'User' }] },
    { name: 'ComposerUsers', members: [{ name: 'Users', type: 'Group' }] },
    { name: 'App.Operators', members: [{ name: 'alice', type: 'User' }] },
    { name: 'Empty', members: [] },
  ],
  roles: [
    { name: 'App.Role.Operator', members: { Group: { 'App.Operators': {} }, PermissionGroup: { 'App.PG.Role.Operator': {} } } },
    { name: 'App.Role.System', members: { User: { System: {} }, PermissionGroup: { 'App.PG.Provision': {} } } },
  ],
  permissionGroups: [
    { name: 'App.PG.Role.Operator', members: { PermissionGroup: { 'App.PG.Facade': {} } } },
    { name: 'App.PG.Facade', members: {} },
    { name: 'App.PG.Provision', members: {} },
    { name: 'App.PG.Unused', members: {} },
  ],
  organizations: [{ name: 'Everyone', organizationalUnits: { Everyone: { name: 'Everyone', members: [{ name: 'Users', type: 'Group' }] } } }],
});

test('a permission group reaches users through the roles that hold it, nested or not', () => {
  assert.deepEqual(directory.rolesHolding('App.PG.Facade'), ['App.Role.Operator']);
  assert.deepEqual(directory.holders({ name: 'App.PG.Facade', type: 'PermissionGroup' }), { system: false, others: ['role App.Role.Operator: group App.Operators'] });
  assert.deepEqual(directory.holders({ name: 'App.PG.Provision', type: 'PermissionGroup' }), { system: true, others: [] });
  assert.deepEqual(directory.holders({ name: 'App.PG.Unused', type: 'PermissionGroup' }), { system: false, others: [] });
});

test('System is in a group through nested groups, and in an organisation through its units', () => {
  assert.equal(directory.groupHoldsSystem('ComposerUsers'), true);
  assert.equal(directory.groupHoldsSystem('App.Operators'), false);
  assert.deepEqual(directory.holders({ name: 'Everyone', type: 'Organization' }), { system: true, others: ['unit Everyone:Everyone: group Users'] });
  // A user group with no members yet is still a grant to users.
  assert.deepEqual(directory.holders({ name: 'Empty', type: 'Group' }), { system: false, others: ['group Empty (no members yet)'] });
});

test('grants for a service include the every-service entry, from every source', () => {
  const sources = [
    { label: 'Thing App.Api', runTime: { permissions: [entry('GetFleet', [allow('App.PG.Facade', 'PermissionGroup')]), entry('Other', [allow('bob', 'User')])] } },
    { label: 'Template App.TT (its Things)', runTime: { permissions: [entry('*', [allow('System', 'User')])] } },
  ];
  const grants = runTimeGrants(sources, 'ServiceInvoke', 'GetFleet');
  assert.deepEqual(grants.map((grant) => [grant.name, grant.source]), [['App.PG.Facade', 'Thing App.Api'], ['System', 'Template App.TT (its Things), every service']]);
  assert.deepEqual([...grantedResources(sources, 'ServiceInvoke')].sort(), ['*', 'GetFleet', 'Other']);
  const access = summariseAccess(grants, directory);
  assert.equal(access.system, 'yes');
  assert.deepEqual(access.others, ['PermissionGroup App.PG.Facade (role App.Role.Operator: group App.Operators)']);
});

test('an explicit deny that reaches System wins; without the directory System access is unknown', () => {
  const grants = [
    { name: 'App.PG.Provision', type: 'PermissionGroup', permitted: true, source: 'x' },
    { name: 'Users', type: 'Group', permitted: false, source: 'x' },
  ];
  assert.equal(summariseAccess(grants, directory).system, 'denied');
  assert.equal(summariseAccess([], directory).system, 'no');
  assert.equal(summariseAccess([], null).system, 'unknown');
  assert.equal(summariseAccess([{ name: 'System', type: 'User', permitted: true, source: 'x' }], null).system, 'yes');
  const visibility = visibilityGrants([{ label: 'Thing A', visibility: { Visibility: [allow('Everyone', 'Organization')] } }]);
  assert.equal(summariseAccess(visibility, directory).system, 'yes');
});

test('the two issues', () => {
  const access = (system: any, others: string[] = []) => ({ system, others, grants: [] });
  assert.deepEqual(serviceIssues({ invoke: access('no'), visibility: access('yes'), calledByServices: 1, calledFromUi: 0 }), ['system-missing']);
  assert.deepEqual(serviceIssues({ invoke: access('yes'), visibility: access('no'), calledByServices: 2, calledFromUi: 0 }), ['system-missing']);
  assert.deepEqual(serviceIssues({ invoke: access('no'), visibility: access('no'), calledByServices: 0, calledFromUi: 0 }), []);
  assert.deepEqual(serviceIssues({ invoke: access('unknown'), visibility: access('unknown'), calledByServices: 3, calledFromUi: 0 }), []);
  assert.deepEqual(serviceIssues({ invoke: access('yes', ['user bob']), visibility: access('yes'), calledByServices: 1, calledFromUi: 0 }), ['users-not-ui']);
  assert.deepEqual(serviceIssues({ invoke: access('yes', ['user bob']), visibility: access('yes'), calledByServices: 0, calledFromUi: 1 }), []);
  assert.deepEqual(serviceIssues({ invoke: access('denied', ['user bob']), visibility: access('yes'), calledByServices: 1, calledFromUi: 0 }), ['system-missing', 'users-not-ui']);
});

const scriptService = (code: string) => ({ handlerName: 'Script', configurationTables: { Script: { rows: [{ code }] } } });

test('the call index finds callers by name and through me, and ignores recursion', () => {
  const holder = {
    collection: 'Things', name: 'App.Facade', body: { thingShape: { serviceImplementations: {
      GetFleet: scriptService('var rows = Things["App.Registry"].Query({}); me.Helper(); me.GetFleet();'),
      Helper: scriptService('Things[name].Query();'),
    } } },
  };
  assert.deepEqual(callsOfHolder(holder).map((call) => `${call.caller.service} -> ${call.key}`), ['GetFleet -> Things/App.Registry.Query', 'GetFleet -> Things/App.Facade.Helper']);
  const index = new ServiceCallIndex();
  index.add(holder);
  index.add({ collection: 'ThingTemplates', name: 'App.TT', body: { thingShape: { serviceImplementations: { Run: scriptService('me.Query();') } } } });
  assert.deepEqual(index.callersOf([serviceKey('Things', 'App.Registry', 'Query'), serviceKey('ThingTemplates', 'App.TT', 'Query')]).map((caller) => `${caller.name}.${caller.service}`),
    ['App.Facade.GetFleet', 'App.TT.Run']);
});

test('UI usage comes from mashup data sources and, by name, from widget JavaScript', () => {
  const mashup = { name: 'App.Mashup', mashupContent: JSON.stringify({ Data: {
    api: { EntityType: 'Things', EntityName: 'App.Api', Services: [{ Name: 'GetFleet' }] },
    dynamic: { EntityType: 'DynamicThingTemplates', EntityName: 'App.TT', Services: [{ Name: 'Status' }] },
    session: { EntityType: 'Session', EntityName: '', Services: [{ Name: 'GetGlobalSessionValues' }] },
  } }) };
  assert.deepEqual(mashupServiceKeys(mashup), ['Things/App.Api.GetFleet', 'ThingTemplates/App.TT.Status']);
  const bundle = 'var Sm="/Thingworx";fetch(`${Sm}/Things/App.Api/Services/${e}`);function rd(e){return wo("GetFleet",{region:e})}';
  assert.equal(scriptNamesService(bundle, ['App.Api'], 'GetFleet'), true);
  assert.equal(scriptNamesService(bundle, ['App.Api'], 'GetFleetSize'), false);
  assert.equal(scriptNamesService(bundle, ['App.Other'], 'GetFleet'), false);
  assert.deepEqual(referencedScripts('s.src = "/Thingworx/Common/extensions/App/ui/app-common/app-elements.js";'), ['/Thingworx/Common/extensions/App/ui/app-common/app-elements.js']);
  const index = new UiUsageIndex();
  index.addMashup('App.Mashup', mashup);
  index.addScript({ label: 'widget app-fleet', text: bundle });
  assert.deepEqual(index.usersOf(['Things/App.Api.GetFleet'], ['App.Api'], 'GetFleet'), ['mashup App.Mashup', 'widget app-fleet']);
  assert.deepEqual(index.usersOf(['Things/App.Api.Decide'], ['App.Api'], 'Decide'), []);
});

test('the Permission Issues tab can be the start tab', () => {
  assert.equal(startTabOf('permissions'), 'permissions');
  assert.equal(startTabOf('Security'), 'security');
});
