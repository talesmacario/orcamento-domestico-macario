const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8').split('\nif (banco) {')[0];
function harness(options = {}) {
  const nodes = new Map(), operations = [], timers = [], storage = options.storage || new Map();
  const controls = { reply: null, storageError: false, session: null, authError: null, logoutError: null, authCalls: 0 };
  function element() {
    const classes = new Set();
    return { value: '', textContent: '', hidden: false, disabled: false, children: [], options: [], style: {}, open: false, returnValue: '', attributes: {},
      classList: { toggle(c, yes) { if (yes) classes.add(c); else classes.delete(c); }, add(c) { classes.add(c); }, remove(c) { classes.delete(c); }, contains(c) { return classes.has(c); } },
      reset() { for (const id of ['descricao', 'valor', 'data']) node(id).value = ''; },
      replaceChildren() { this.children = []; }, append(...children) { this.children.push(...children); },
      add(option) { this.options.push(option); }, setAttribute(name, value) { this.attributes[name] = value; }, addEventListener(event, fn) { if (event === 'close') this.onClose = fn; else this[event] = fn; },
      scrollIntoView() {}, focus() {}, showModal() { this.open = true; }, close(value) { if (value !== undefined) this.returnValue = value; this.open = false; this.onClose?.(); }, querySelectorAll() { return []; }, click() {}, remove() { this.removed = true; }
    };
  }
  function node(id) { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); }
  const banco = {
    auth: {
      onAuthStateChange(fn) { controls.authCallback = fn; return { data: { subscription: { unsubscribe() {} } } }; },
      async getSession() { return { data: { session: controls.session }, error: controls.authError }; },
      async signInWithPassword() { controls.authCalls++; return { data: { session: controls.session }, error: controls.authError }; },
      async signOut() { return { error: controls.logoutError }; }
    },
    from(table) {
      const op = { table, action: 'read' }; operations.push(op);
      return {
        insert(payload) { op.action = 'insert'; op.payload = payload; return this; },
        update(payload) { op.action = 'update'; op.payload = payload; return this; },
        delete() { op.action = 'delete'; return this; },
        eq(field, value) { op.filter = [field, value]; return this; },
        gte(field, value) { op.gte = [field, value]; return this; }, lt(field, value) { op.lt = [field, value]; return this; }, select(fields) { op.fields = fields; return this; }, order() { return this; },
        retry(enabled) { op.retry = enabled; return this; },
        range(from, to) { op.range = [from, to]; return this; },
        then(resolve, reject) {
          return Promise.resolve().then(() => controls.reply ? controls.reply(op)
            : { data: op.action === 'read' ? [] : [{ id: op.filter?.[1] || 123 }], error: null, status: 200 }).then(resolve, reject);
        }
      };
    }
  };
  const context = vm.createContext({
    supabase: { createClient: () => banco },
    sessionStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem(key, value) { if (controls.storageError) throw Error('storage unavailable'); storage.set(key, value); },
      removeItem(key) { if (controls.storageError) throw Error('storage unavailable'); storage.delete(key); }
    },
    document: { getElementById: node, createElement: element, querySelector: () => node('featured'), querySelectorAll: selector => selector === 'dialog' ? [node('confirmacao'), node('conferenciaGravacao')] : selector === '[data-financial-content]' ? [node('textoConfirmacao'), node('textoConferencia')] : [], body: element() },
    Intl, Date, Number, String, BigInt, Map, Promise, TypeError, URL, Blob, crypto: require('node:crypto').webcrypto,
    setTimeout: fn => { timers.push(fn); return timers.length; }, console, Option: class { constructor(value) { this.value = value; } setAttribute() {} }
  });
  vm.runInContext(source + '\nthis.api = { state, salvar, carregar, soma, centavos, decimal, dinheiro, registrosMes, categoria, excluir, csvCell, entrar, sair, iniciar, aplicarSessao, restaurarPendencia, revisarGravacao, graficoCategorias, exportarCsv, confirmarExclusao, invalidarSessao, editar };', context);
  const api = context.api;
  api.state.userId = 'test-user';
  node('mes').value = '2026-09'; node('descricao').value = 'Supermercado';
  node('valor').value = '90.51'; node('data').value = '2026-09-26'; node('categoria').value = 'Alimentação';
  return { api, node, operations, controls, storage, context, timers, writes: () => operations.filter(op => op.action !== 'read') };
}
const event = { preventDefault() {} };
const session = id => ({ user: { id } });

for (const kind of ['receita', 'despesa']) {
  test(`inserts ${kind} using existing column names and refreshes totals`, async () => {
    const h = harness(); h.api.state.tipo = kind;
    h.controls.reply = op => ({ data: op.action === 'read' ? (op.table === (kind === 'receita' ? 'Receitas' : 'Despesas') ? [{ ...h.writes()[0].payload, id: 123 }] : []) : [{ id: 123 }], status: 200 });
    await h.api.salvar(event);
    const op = h.writes()[0];
    assert.equal(op.table, kind === 'receita' ? 'Receitas' : 'Despesas');
    assert.equal(op.payload[kind === 'receita' ? 'Descrição' : 'Descricao'], 'Supermercado');
    assert.equal(op.payload.Valor, 90.51);
    assert.equal(op.retry, false);
    assert.equal(op.payload.categoria, kind === 'despesa' ? 'Alimentação' : undefined);
    assert.equal(h.node('mensagem').textContent, 'Lançamento cadastrado.');
    assert.equal(h.node('total' + (kind === 'receita' ? 'Receitas' : 'Despesas')).textContent, 'R$\xa090,51');
    assert.equal(h.node('descricao').value, '');
    assert.equal(h.api.state.pendingWrite, null);
  });
  test(`updates ${kind} by id without changing schema`, async () => {
    const h = harness(); h.api.state.tipo = kind; h.api.state.editando = { id: 19, tipo: kind };
    await h.api.salvar(event);
    assert.equal(h.writes()[0].action, 'update'); assert.deepEqual(h.writes()[0].filter, ['id', 19]);
    assert.equal(h.writes()[0].payload.user_id, undefined);
    assert.equal(h.node('mensagem').textContent, 'Lançamento atualizado.');
  });
}

test('confirmed save and failed refresh preserve warning, clear draft and retry only reads', async () => {
  const h = harness(); let failed = true;
  h.controls.reply = op => op.action === 'read' && failed
    ? { error: { message: 'service unavailable' }, status: 503 }
    : { data: op.action === 'read' ? [] : [{ id: 123 }], status: 200 };
  await h.api.salvar(event);
  assert.match(h.node('mensagem').textContent, /Gravação concluída.*não foi atualizada/);
  assert.equal(h.node('mensagem').classList.contains('ok'), false);
  assert.equal(h.node('descricao').value, ''); assert.equal(h.node('salvar').disabled, true);
  await h.api.salvar(event); assert.equal(h.writes().length, 1);
  failed = false; assert.equal(await h.api.carregar(), true);
  assert.equal(h.writes().length, 1); assert.equal(h.node('salvar').disabled, false);
  assert.equal(h.api.state.pendingWrite, null);
});

test('concurrent submits dispatch just one mutation', async () => {
  const h = harness(); let release;
  h.controls.reply = op => op.action === 'read' ? { data: [], status: 200 }
    : new Promise(resolve => { release = resolve; });
  const first = h.api.salvar(event); await Promise.resolve(); await Promise.resolve();
  await h.api.salvar(event); assert.equal(h.writes().length, 1);
  release({ data: [{ id: 123 }], status: 200 }); await first;
});

for (const failure of [
  { error: { message: 'Failed to fetch' }, status: 0 },
  { error: { message: 'unavailable' }, status: 503 },
  { data: [], status: 201 }
]) {
  test(`uncertain write (${failure.status}) blocks retries, including after reload`, async () => {
    const h = harness(); h.controls.reply = () => failure;
    await h.api.salvar(event); await h.api.salvar(event);
    assert.equal(h.writes().length, 1); assert.equal(h.api.state.pendingWrite.phase, 'uncertain');
    assert.match(h.node('mensagem').textContent, /Não foi possível confirmar/);
    const reloaded = harness({ storage: h.storage }); reloaded.api.restaurarPendencia('test-user');
    await reloaded.api.carregar(); await reloaded.api.salvar(event);
    assert.equal(reloaded.writes().length, 0); assert.equal(reloaded.node('revisarGravacao').disabled, false);
    const review = reloaded.api.revisarGravacao();
    reloaded.node('resultadoConferencia').value = 'not-completed'; reloaded.node('conferenciaGravacao').returnValue = 'confirm'; reloaded.node('conferenciaGravacao').close(); await review;
    assert.equal(reloaded.api.state.pendingWrite, null); assert.equal(reloaded.node('descricao').value, '');
  });
}

test('confirmed marker survives reload and is removed only after successful read', async () => {
  const h = harness(); h.controls.reply = op => op.action === 'read' ? { error: { message: 'offline' }, status: 503 } : { data: [{ id: 123 }], status: 201 };
  await h.api.salvar(event);
  const reloaded = harness({ storage: h.storage }); reloaded.api.restaurarPendencia('test-user');
  assert.equal(reloaded.api.state.pendingWrite.phase, 'confirmed');
  assert.equal(reloaded.node('salvar').disabled, true);
  await reloaded.api.carregar(); assert.equal(reloaded.api.state.pendingWrite, null);
  assert.equal(reloaded.writes().length, 0);
});

test('definitive policy rejection preserves draft and allows correction', async () => {
  const h = harness(); h.controls.reply = () => ({ error: { code: '42501' }, status: 403 });
  await h.api.salvar(event);
  assert.equal(h.api.state.pendingWrite, null); assert.equal(h.node('salvar').disabled, false);
  assert.equal(h.node('descricao').value, 'Supermercado'); assert.match(h.node('mensagem').textContent, /permissões/);
});

test('storage failure prevents dispatch of a write that cannot be remembered', async () => {
  const h = harness(); h.controls.storageError = true; await h.api.salvar(event);
  assert.equal(h.writes().length, 0); assert.match(h.node('mensagem').textContent, /armazenamento/);
});

test('logout during write cannot display success or update another account', async () => {
  const h = harness(); let release;
  h.controls.reply = () => new Promise(resolve => { release = resolve; });
  const save = h.api.salvar(event); await Promise.resolve(); await Promise.resolve();
  h.api.aplicarSessao(null); release({ data: [{ id: 123 }], status: 201 }); await save;
  assert.equal(h.node('painel').hidden, true); assert.equal(h.node('totalReceitas').textContent, '—');
  assert.equal(h.operations.filter(op => op.action === 'read').length, 0);
  h.api.aplicarSessao(session('test-user')); assert.equal(h.api.state.pendingWrite.phase, 'uncertain');
});

test('stale reads after logout are discarded', async () => {
  const h = harness(); const releases = [];
  h.controls.reply = () => new Promise(resolve => releases.push(resolve));
  const load = h.api.carregar(); await Promise.resolve(); await Promise.resolve();
  h.api.aplicarSessao(null); releases.forEach(resolve => resolve({ data: [{ id: 1, Valor: '10.00' }] }));
  assert.equal(await load, false); assert.equal(h.api.state.receitas.length, 0);
});

test('auth events update session, defer SDK queries and avoid reloading on token refresh', async () => {
  const h = harness(); h.api.state.userId = null;
  await h.api.iniciar(); assert.equal(h.node('login').hidden, false);
  h.controls.authCallback('SIGNED_IN', session('alice'));
  assert.equal(h.api.state.userId, 'alice'); assert.equal(h.operations.length, 0);
  const queued = h.timers.length;
  h.controls.authCallback('TOKEN_REFRESHED', session('alice')); assert.equal(h.timers.length, queued);
  h.node('descricao').value = 'private draft';
  h.controls.authCallback('SIGNED_OUT', null);
  assert.equal(h.node('painel').hidden, true); assert.equal(h.node('descricao').value, '');
  h.timers.forEach(fn => fn()); assert.equal(h.operations.length, 0);
});

test('late initial session cannot overwrite a newer auth event', async () => {
  const h = harness(); h.api.state.userId = null;
  vm.runInContext('banco.auth.getSession = () => new Promise(resolve => { this.resolveSession = resolve; });', h.context);
  const start = h.api.iniciar(); h.controls.authCallback('SIGNED_IN', session('new-user'));
  h.context.resolveSession({ data: { session: null } }); await start;
  assert.equal(h.api.state.userId, 'new-user'); assert.equal(h.node('painel').hidden, false);
});

for (const [error, pattern] of [
  [{ code: 'invalid_credentials', status: 400 }, /E-mail ou senha incorretos/],
  [{ code: 'email_not_confirmed', status: 400 }, /Confirme seu e-mail/],
  [{ name: 'AuthRetryableFetchError', message: 'Failed to fetch', status: 0 }, /conectar.*conexão/],
  [{ status: 503 }, /temporariamente indisponível/],
  [{ status: 429 }, /Muitas tentativas/]
]) {
  test(`login distinguishes ${error.code || error.status || error.name} and clears password`, async () => {
    const h = harness(); h.controls.authError = error; h.node('senha').value = 'synthetic';
    await h.api.entrar(event); assert.match(h.node('mensagemLogin').textContent, pattern);
    assert.equal(h.node('senha').value, ''); assert.equal(h.node('entrar').disabled, false);
  });
}

test('logout failure keeps current session and reports service failure', async () => {
  const h = harness(); h.controls.logoutError = { status: 503 };
  await h.api.sair(); assert.equal(h.api.state.userId, 'test-user'); assert.match(h.node('mensagem').textContent, /indisponível/);
});

test('integer cents eliminate accumulation and subtraction rounding errors', () => {
  const h = harness(), a = h.api;
  assert.equal(a.soma([{ Valor: '0.10' }, { Valor: '0.20' }]), 30n);
  assert.equal(a.soma(Array.from({ length: 1000 }, () => ({ Valor: '0.01' }))), 1000n);
  assert.equal(a.soma([{ Valor: '0.30' }]) - a.soma([{ Valor: '0.10' }, { Valor: '0.20' }]), 0n);
  assert.equal(a.centavos('1.005'), 101n); assert.equal(a.centavos('-1.005'), -101n);
  assert.equal(a.centavos(1e-7), 0n);
  assert.equal(a.dinheiro(-1n), '-R$\xa00,01'); assert.equal(a.decimal(9007199254740993n), '90071992547409.93');
  assert.equal(a.dinheiro(9007199254740993n), 'R$\xa090.071.992.547.409,93');
  assert.throws(() => a.centavos('NaN')); assert.throws(() => a.centavos(Infinity));
});

test('numeric payload rounds decimal ties correctly and rejects excessive input', async () => {
  const h = harness(); h.node('valor').value = '1.005'; await h.api.salvar(event);
  assert.equal(h.writes()[0].payload.Valor, 1.01);
  h.node('descricao').value = 'too large'; h.node('valor').value = '10000000000'; await h.api.salvar(event);
  assert.equal(h.writes().length, 1);
});

test('month filtering and default categories are preserved', () => {
  const { api } = harness();
  const rows = [{ Data: '2026-09-26', Valor: '90.51', categoria: 'Alimentação' }, { Data: '2026-08-28', Valor: 2100 }];
  assert.equal(api.soma(api.registrosMes(rows, '2026-09')), 9051n); assert.equal(api.categoria(rows[1]), 'Sem categoria');
});

test('deletion remains confirmation-gated and constrained to the chosen id', async () => {
  const h = harness(); vm.runInContext('confirmarExclusao = async () => false;', h.context);
  await h.api.excluir({ id: 33 }, 'despesa'); assert.equal(h.writes().length, 0);
  vm.runInContext('confirmarExclusao = async () => true;', h.context);
  await h.api.excluir({ id: 33 }, 'despesa');
  assert.equal(h.writes()[0].table, 'Despesas'); assert.deepEqual(h.writes()[0].filter, ['id', 33]);
  assert.equal(h.node('mensagem').textContent, 'Lançamento excluído.');
});

test('CSV continues escaping formulas and quotes', () => {
  const { api } = harness(); assert.equal(api.csvCell('=1+1'), '"\'=1+1"'); assert.equal(api.csvCell('A "B"'), '"A ""B"""');
});

test('a read during an unresolved write cannot authorize review of a lost response', async () => {
  const h = harness(); let release;
  h.controls.reply = op => op.action === 'read' ? { data: [], status: 200 }
    : new Promise(resolve => { release = resolve; });
  const save = h.api.salvar(event); await Promise.resolve(); await Promise.resolve();
  await h.api.carregar();
  release({ error: { message: 'Failed to fetch' }, status: 0 }); await save;
  assert.equal(h.api.state.reviewReady, false); assert.equal(h.node('revisarGravacao').disabled, true);
  await h.api.carregar(); assert.equal(h.node('revisarGravacao').disabled, false);
});

test('session rejection hides data and asks for authentication again', async () => {
  const h = harness(); h.controls.reply = () => ({ error: { code: 'PGRST301' }, status: 401 });
  await h.api.carregar(); assert.equal(h.api.state.userId, null);
  assert.equal(h.node('painel').hidden, true); assert.match(h.node('mensagemLogin').textContent, /sessão expirou/);
});

test('write markers remain separate when switching accounts', async () => {
  const h = harness(); h.controls.reply = () => ({ error: { message: 'Failed to fetch' }, status: 0 });
  await h.api.salvar(event);
  h.api.aplicarSessao(session('other-user')); assert.equal(h.api.state.pendingWrite, null);
  h.api.aplicarSessao(session('test-user')); assert.equal(h.api.state.pendingWrite.phase, 'uncertain');
});

test('deletion confirmation opened by another session cannot dispatch', async () => {
  const h = harness();
  vm.runInContext('confirmarExclusao = () => new Promise(resolve => { this.confirmDelete = resolve; });', h.context);
  const deletion = h.api.excluir({ id: 33 }, 'despesa');
  h.api.aplicarSessao(session('other-user')); h.context.confirmDelete(true); await deletion;
  assert.equal(h.writes().length, 0);
});

test('failed read while review dialog is open prevents premature unlocking', async () => {
  const h = harness(); h.controls.reply = () => ({ error: { message: 'Failed to fetch' }, status: 0 });
  await h.api.salvar(event);
  h.controls.reply = () => ({ data: [], status: 200 }); await h.api.carregar();
  const review = h.api.revisarGravacao();
  h.controls.reply = () => ({ error: { message: 'unavailable' }, status: 503 }); await h.api.carregar();
  h.node('resultadoConferencia').value = 'completed'; h.node('conferenciaGravacao').returnValue = 'confirm'; h.node('conferenciaGravacao').close(); await review;
  assert.equal(h.api.state.pendingWrite.phase, 'uncertain'); assert.equal(h.node('salvar').disabled, true);
});

test('late login response cannot restore a session that already signed out', async () => {
  const h = harness(); h.api.state.userId = null; await h.api.iniciar();
  vm.runInContext('banco.auth.signInWithPassword = () => new Promise(resolve => { this.resolveLogin = resolve; });', h.context);
  const login = h.api.entrar(event);
  h.controls.authCallback('SIGNED_IN', session('test-user'));
  h.controls.authCallback('SIGNED_OUT', null);
  h.context.resolveLogin({ data: { session: session('test-user') } }); await login;
  assert.equal(h.api.state.userId, null); assert.equal(h.node('painel').hidden, true);
});

test('returning to the same account during a pending write requires a fresh read after completion', async () => {
  const h = harness(); let release;
  h.controls.reply = op => op.action === 'read' ? { data: [], status: 200 }
    : new Promise(resolve => { release = resolve; });
  const save = h.api.salvar(event); await Promise.resolve(); await Promise.resolve();
  h.api.aplicarSessao(null); h.api.aplicarSessao(session('test-user'));
  await h.api.carregar();
  release({ data: [{ id: 123 }], status: 201 }); await save;
  assert.equal(h.api.state.pendingWrite.phase, 'uncertain');
  assert.equal(h.api.state.reviewReady, false); assert.equal(h.node('revisarGravacao').disabled, true);
  await h.api.carregar(); assert.equal(h.node('revisarGravacao').disabled, false);
});

for (const transition of ['logout', 'expired', 'switch-user']) {
  test(`${transition} closes every dialog and removes previous financial and personal content`, async () => {
    const h = harness();
    h.node('textoConfirmacao').textContent = 'PRIVATE expense R$ 12,34';
    h.node('textoConferencia').textContent = 'PRIVATE operation R$ 90,51';
    h.node('conferenciaGravacao').showModal();
    const deletion = h.api.confirmarExclusao({ id: 7, Descricao: 'PRIVATE expense', Valor: '12.34' }, 'despesa');
    h.node('descricao').value = 'PRIVATE draft'; h.node('valor').value = '12.34';
    h.node('email').value = 'private@example.invalid'; h.node('senha').value = 'private password';
    h.node('contagemDespesas').textContent = '(33)'; h.node('contagemReceitas').textContent = '(8)';
    h.node('mensagem').textContent = 'PRIVATE feedback';
    const option = { removed: false, remove() { this.removed = true; } };
    h.node('categoria').querySelectorAll = () => [option];
    if (transition === 'logout') await h.api.sair();
    else if (transition === 'expired') h.api.invalidarSessao();
    else h.api.aplicarSessao(session('other-user'));
    assert.equal(await deletion, false);
    for (const id of ['confirmacao', 'conferenciaGravacao']) {
      assert.equal(h.node(id).open, false); assert.equal(h.node(id).returnValue, '');
    }
    for (const id of ['textoConfirmacao', 'textoConferencia', 'descricao', 'valor', 'email', 'senha'])
      assert.equal(id.startsWith('texto') ? h.node(id).textContent : h.node(id).value, '');
    assert.equal(h.node('contagemDespesas').textContent, ''); assert.equal(h.node('contagemReceitas').textContent, '');
    assert.equal(h.node('mensagem').textContent, ''); assert.equal(option.removed, true);
    assert.equal(h.writes().length, 0);
  });
}

for (const kind of ['receita', 'despesa']) {
  test(`uncertain ${kind} preserves operation identity and reads the intended year/month after reload`, async () => {
    const h = harness(); h.api.state.tipo = kind;
    h.node('data').value = '2025-12-31'; h.node('mes').value = '2026-10';
    h.controls.reply = () => ({ error: { message: 'Failed to fetch' }, status: 0 });
    await h.api.salvar(event);
    const pending = h.api.state.pendingWrite;
    assert.match(pending.operationId, /^[0-9a-f-]{36}$/); assert.equal(pending.month, '2025-12');
    assert.equal(pending.action, 'insert'); assert.equal(pending.tipo, kind);
    assert.equal(pending.entry.description, 'Supermercado'); assert.equal(pending.entry.amount, '90.51');
    const restored = harness({ storage: h.storage }); restored.node('mes').value = '2026-11';
    restored.api.restaurarPendencia('test-user');
    assert.equal(restored.api.state.pendingWrite.operationId, pending.operationId);
    assert.equal(await restored.api.carregar(), true);
    const periodQuery = restored.operations.find(op => op.gte);
    assert.equal(periodQuery.table, kind === 'receita' ? 'Receitas' : 'Despesas');
    assert.deepEqual(periodQuery.gte, ['Data', '2025-12-01']); assert.deepEqual(periodQuery.lt, ['Data', '2026-01-01']);
    assert.equal(restored.node('mes').value, '2025-12');
    assert.equal(restored.api.state.pendingWrite.phase, 'uncertain'); assert.equal(restored.node('salvar').disabled, true);
    const review = restored.api.revisarGravacao();
    assert.match(restored.node('textoConferencia').textContent, /31\/12\/2025/);
    assert.ok(restored.node('textoConferencia').textContent.includes(pending.operationId));
    assert.ok(restored.node('textoConferencia').textContent.includes('90,51'));
    restored.node('conferenciaGravacao').close('cancel'); await review;
    assert.equal(restored.api.state.pendingWrite.phase, 'uncertain'); assert.equal(restored.writes().length, 0);
  });
}

test('a failed period query does not authorize review even if complete history reads succeed', async () => {
  const h = harness(); h.controls.reply = () => ({ error: { message: 'Failed to fetch' }, status: 0 });
  await h.api.salvar(event);
  h.controls.reply = op => op.gte ? { error: { message: 'period query failed' }, status: 503 } : { data: [], status: 200 };
  assert.equal(await h.api.carregar(), false);
  assert.equal(h.api.state.reviewReady, false); assert.equal(h.node('revisarGravacao').disabled, true);
  assert.equal(h.node('salvar').disabled, true); assert.equal(h.api.state.pendingWrite.phase, 'uncertain');
});

test('changing the visible period prevents unlocking until the pending month is displayed again', async () => {
  const h = harness(); h.controls.reply = () => ({ error: { message: 'Failed to fetch' }, status: 0 });
  await h.api.salvar(event); h.controls.reply = () => ({ data: [], status: 200 }); await h.api.carregar();
  const review = h.api.revisarGravacao(); h.node('mes').value = '2026-08';
  h.node('resultadoConferencia').value = 'completed'; h.node('conferenciaGravacao').close('confirm'); await review;
  assert.equal(h.api.state.pendingWrite.phase, 'uncertain');
  await h.api.carregar(); assert.equal(h.node('mes').value, '2026-09');
  assert.equal(h.node('revisarGravacao').disabled, false);
});

test('a legacy pending operation without a recoverable period stays blocked instead of assuming the current month', async () => {
  const h = harness();
  h.storage.set('macario.pending-write.v1.test-user', JSON.stringify({ userId: 'test-user', phase: 'uncertain' }));
  h.api.restaurarPendencia('test-user'); await h.api.carregar();
  assert.equal(h.node('salvar').disabled, true); assert.equal(h.node('revisarGravacao').disabled, true);
  assert.match(h.node('mensagem').textContent, /não possui identificação e período/);
  assert.equal(h.operations.some(op => op.gte), false);
});

test('uncertain update and deletion keep their target record and original operation type', async () => {
  const h = harness(); h.api.state.editando = { id: 22, tipo: 'despesa' };
  h.controls.reply = () => ({ error: { message: 'Failed to fetch' }, status: 0 });
  await h.api.salvar(event); assert.equal(h.api.state.pendingWrite.action, 'update');
  assert.equal(h.api.state.pendingWrite.recordId, 22);
  const d = harness(); d.controls.reply = h.controls.reply;
  vm.runInContext('confirmarExclusao = async () => true;', d.context);
  await d.api.excluir({ id: 19, Data: '2025-01-17', Valor: '12.34', Descricao: 'Synthetic old expense' }, 'despesa');
  assert.equal(d.api.state.pendingWrite.action, 'delete'); assert.equal(d.api.state.pendingWrite.recordId, 19);
  assert.equal(d.api.state.pendingWrite.month, '2025-01');
});

test('pending details from another user are not restored into the interface', async () => {
  const h = harness(); h.controls.reply = () => ({ error: { message: 'Failed to fetch' }, status: 0 });
  h.node('descricao').value = 'PRIVATE saved draft'; await h.api.salvar(event);
  h.api.aplicarSessao(session('other-user'));
  assert.equal(h.api.state.pendingWrite, null); assert.equal(h.node('textoConferencia').textContent, '');
  assert.equal(h.node('descricao').value, '');
  h.api.aplicarSessao(session('test-user')); assert.equal(h.api.state.pendingWrite.entry.description, 'PRIVATE saved draft');
});

test('pending period reads remain paginated and retain both date bounds on every page', async () => {
  const h = harness(); h.node('data').value = '2025-12-31';
  h.controls.reply = () => ({ error: { message: 'Failed to fetch' }, status: 0 }); await h.api.salvar(event);
  const rows = Array.from({ length: 501 }, (_, id) => ({ id: id + 1, Data: '2025-12-31', Descricao: 'Synthetic cent', Valor: '0.01' }));
  h.controls.reply = op => ({ data: op.gte ? rows.slice(op.range[0], op.range[1] + 1) : [], status: 200 });
  await h.api.carregar(); const queries = h.operations.filter(op => op.gte);
  assert.equal(queries.length, 2); assert.deepEqual(queries.map(op => op.range), [[0, 499], [500, 999]]);
  queries.forEach(op => { assert.deepEqual(op.gte, ['Data', '2025-12-01']); assert.deepEqual(op.lt, ['Data', '2026-01-01']); });
  assert.equal(h.api.soma(h.api.state.despesas), 501n); assert.equal(h.api.state.pendingWrite.phase, 'uncertain');
});

test('reusing deletion dialog cannot reuse an earlier confirm result when the next dialog is dismissed', async () => {
  const h = harness(); const row = { id: 7, Descricao: 'Synthetic', Valor: '12.34' };
  const first = h.api.confirmarExclusao(row, 'despesa'); h.node('confirmacao').close('confirm');
  assert.equal(await first, true);
  const second = h.api.confirmarExclusao(row, 'despesa'); h.node('confirmacao').close();
  assert.equal(await second, false);
});

test('confirmed operation identity and intended month survive a failed refresh and reload', async () => {
  const h = harness(); h.node('data').value = '2025-12-31';
  h.controls.reply = op => op.action === 'read' ? { error: { message: 'offline' }, status: 503 } : { data: [{ id: 123 }], status: 201 };
  await h.api.salvar(event); const id = h.api.state.pendingWrite.operationId;
  const restored = harness({ storage: h.storage }); restored.api.restaurarPendencia('test-user');
  assert.equal(restored.api.state.pendingWrite.operationId, id); assert.equal(restored.api.state.pendingWrite.month, '2025-12');
  await restored.api.carregar(); assert.equal(restored.node('mes').value, '2025-12');
  assert.equal(restored.writes().length, 0); assert.equal(restored.api.state.pendingWrite, null);
});

for (const raw of ['', 'invalid JSON', JSON.stringify({ userId: 'other-user', entry: { description: 'PRIVATE other user' } })]) {
  test(`unrecoverable stored marker remains blocked without exposing foreign data (${raw.slice(0, 20)})`, async () => {
    const h = harness(); h.storage.set('macario.pending-write.v1.test-user', raw);
    h.api.restaurarPendencia('test-user'); await h.api.carregar();
    assert.equal(h.api.state.pendingWrite.phase, 'uncertain'); assert.equal(h.node('salvar').disabled, true);
    assert.equal(h.node('revisarGravacao').disabled, true);
    assert.equal(h.api.state.pendingWrite.entry, undefined);
  });
}

for (const resolution of ['', 'uncertain']) {
  test(`review without a definite human result keeps the operation pending (${resolution || 'omitted'})`, async () => {
    const h = harness(); h.controls.reply = () => ({ error: { message: 'Failed to fetch' }, status: 0 });
    await h.api.salvar(event); h.controls.reply = () => ({ data: [], status: 200 }); await h.api.carregar();
    const review = h.api.revisarGravacao(); h.node('resultadoConferencia').value = resolution;
    h.node('conferenciaGravacao').close('confirm'); await review;
    assert.equal(h.api.state.pendingWrite.phase, 'uncertain'); assert.equal(h.node('salvar').disabled, true);
    assert.equal(h.writes().length, 1);
  });
}
