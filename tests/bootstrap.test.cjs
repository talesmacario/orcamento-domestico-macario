const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'bootstrap.js'), 'utf8');
function setup() {
  const nodes = new Map(); let timer, cleared = false, reloads = 0;
  function node(id) {
    if (!nodes.has(id)) nodes.set(id, { hidden: true, textContent: '', addEventListener(event, handler) { this[event] = handler; } });
    return nodes.get(id);
  }
  const context = vm.createContext({ document: { getElementById: node },
    setTimeout(fn, milliseconds) { assert.equal(milliseconds, 15000); timer = fn; return 1; },
    clearTimeout() { cleared = true; }, location: { reload() { reloads++; } }
  });
  vm.runInContext(source, context);
  return { node, context, timeout: () => timer(), cleared: () => cleared, reloads: () => reloads };
}
test('SDK error reveals accessible feedback and retry action', () => {
  const h = setup(); h.node('supabaseSdk').error();
  assert.equal(h.node('inicializacao').hidden, false);
  assert.match(h.node('mensagemInicializacao').textContent, /Não foi possível iniciar/);
  assert.equal(h.node('tentarInicializacao').hidden, false);
  h.node('tentarInicializacao').click(); assert.equal(h.reloads(), 1);
});
test('stalled download gets a timeout message', () => {
  const h = setup(); h.timeout(); assert.equal(h.node('tentarInicializacao').hidden, false);
});
test('successful startup cancels timer and ignores late SDK errors', () => {
  const h = setup(); h.context.appBootstrap.ready(); h.timeout(); h.node('supabaseSdk').error();
  assert.equal(h.cleared(), true); assert.equal(h.node('inicializacao').hidden, true);
});
test('late SDK recovery after timeout clears failure panel', () => {
  const h = setup(); h.timeout(); h.context.appBootstrap.ready(); assert.equal(h.node('inicializacao').hidden, true);
});
