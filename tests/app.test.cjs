const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const nodes = new Map();
function node(id) {
  if (!nodes.has(id)) nodes.set(id, {
    value: "", textContent: "", hidden: false, disabled: false, classList: { toggle() {}, add() {}, remove() {} },
    reset() {}, replaceChildren() {}, append() {}, setAttribute() {}, addEventListener() {}, scrollIntoView() {}, focus() {}
  });
  return nodes.get(id);
}
const operations = [];
const banco = {
  from(table) {
    const op = { table };
    operations.push(op);
    return {
      insert(payload) { op.action = "insert"; op.payload = payload; return this; },
      update(payload) { op.action = "update"; op.payload = payload; return this; },
      delete() { op.action = "delete"; return this; },
      eq(field, value) { op.filter = [field, value]; return this; },
      select() { return Promise.resolve({ data: [{ id: op.filter?.[1] || 123 }], error: null }); }
    };
  }
};
const context = vm.createContext({
  supabase: { createClient: () => banco }, document: { getElementById: node, querySelector: () => ({ classList: { toggle() {} } }) },
  Intl, Date, Number, String, Map, Promise, setTimeout, console, Option: class {}, URL, Blob
});
const source = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8").replace(/iniciar\(\);\s*$/, "");
vm.runInContext(source + "\nthis.api = { state, salvar, soma, registrosMes, descricao, categoria, cancelarEdicao, excluir, csvCell };", context);
const api = context.api;
node("mes").value = "2026-09";
node("descricao").value = "Supermercado";
node("valor").value = "90.51";
node("data").value = "2026-09-26";
node("categoria").value = "Alimentação";
// Keep tests focused on mutation payloads, without rendering an unrelated chart.
vm.runInContext("carregar = async () => {};", context);

test("saves a categorized expense into the existing Despesas column names", async () => {
  await api.salvar({ preventDefault() {} });
  const op = operations.at(-1);
  assert.equal(op.table, "Despesas");
  assert.equal(op.action, "insert");
  assert.equal(op.payload.Descricao, "Supermercado");
  assert.equal(op.payload.Valor, 90.51);
  assert.equal(op.payload.categoria, "Alimentação");
  assert.equal(op.payload.Data, "2026-09-26");
  assert.equal(node("mensagem").textContent, "Lançamento cadastrado.");
});

test("edits a receipt by id without inventing a user_id column", async () => {
  api.state.tipo = "receita";
  api.state.editando = { id: 19, tipo: "receita" };
  node("descricao").value = "Salário PROCON";
  node("valor").value = "2100";
  node("data").value = "2026-08-28";
  await api.salvar({ preventDefault() {} });
  const op = operations.at(-1);
  assert.equal(op.table, "Receitas");
  assert.equal(op.action, "update");
  assert.deepEqual(op.filter, ["id", 19]);
  assert.equal(op.payload["Descrição"], "Salário PROCON");
  assert.equal(op.payload.categoria, undefined);
});

test("month filtering and category totals use the actual Data and Valor fields", () => {
  const rows = [{ Data: "2026-09-26", Valor: "90.51", categoria: "Alimentação" }, { Data: "2026-08-28", Valor: 2100 }];
  assert.equal(api.soma(api.registrosMes(rows, "2026-09")), 90.51);
  assert.equal(api.categoria(rows[1]), "Sem categoria");
});

test("deletes only the confirmed expense id", async () => {
  vm.runInContext("confirmarExclusao = async () => true;", context);
  await api.excluir({ id: 33, Descricao: "Lanche", Valor: 25 }, "despesa");
  const op = operations.at(-1);
  assert.equal(op.table, "Despesas");
  assert.equal(op.action, "delete");
  assert.deepEqual(op.filter, ["id", 33]);
  assert.equal(node("mensagem").textContent, "Lançamento excluído.");
});

test("rejects spreadsheet formulas in exported descriptions", () => {
  assert.equal(api.csvCell("=1+1"), '"\'=1+1"');
  assert.equal(api.csvCell('A "B"'), '"A ""B"""');
});
