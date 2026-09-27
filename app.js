/* Only the Supabase publishable key belongs here. Authorization remains in Supabase RLS. */
const SUPABASE_URL = "https://jbglqcaeopuznaxmiuss.supabase.co";
const SUPABASE_KEY = "sb_publishable_sU-QdaTiWD_nRiqHz5lHLw_juyjRG8F";
const banco = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
const SCHEMA = {
  receita: { table: "Receitas", description: "Descrição" },
  despesa: { table: "Despesas", description: "Descricao" }
};
const $ = id => document.getElementById(id);
const moeda = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const state = { receitas: [], despesas: [], tipo: "despesa", editando: null, loadId: 0 };

function hoje() {
  // Date inputs and month filters must reflect the user's local day, not UTC.
  const d = new Date();
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0")].join("-");
}
function valor(r) { return Number(r.Valor || 0); }
function data(r) { return String(r.Data || "").slice(0, 10); }
function categoria(r) { return String(r.categoria || "Sem categoria"); }
function descricao(r, tipo) { return String(r[SCHEMA[tipo].description] || "Sem descrição"); }
function dinheiro(n) { return moeda.format(n); }
function aviso(message, ok = false) {
  $("mensagem").textContent = message;
  $("mensagem").classList.toggle("ok", ok);
}
function mostrarAutenticacao(logado) {
  $("painel").hidden = !logado;
  $("login").hidden = logado;
  if (!logado) { state.receitas = []; state.despesas = []; state.loadId++; }
}
function selecionarTipo(tipo) {
  state.tipo = tipo;
  for (const t of ["receita", "despesa"]) {
    const btn = $("tipo" + (t === "receita" ? "Receita" : "Despesa"));
    btn.classList.toggle("active", t === tipo);
    btn.setAttribute("aria-pressed", String(t === tipo));
  }
  $("categoriaWrap").hidden = tipo === "receita";
  $("salvar").textContent = (state.editando ? "Salvar alterações" : "Salvar ") + (state.editando ? "" : tipo);
  $("formTitle").textContent = state.editando ? "Editar lançamento" : "Adicionar lançamento";
}
function cancelarEdicao() {
  state.editando = null;
  $("lancamentoForm").reset();
  $("data").value = hoje();
  $("cancelar").hidden = true;
  selecionarTipo(state.tipo);
}
function registrosMes(rows, mes) { return rows.filter(r => data(r).slice(0, 7) === mes); }
function soma(rows) { return rows.reduce((acc, r) => acc + valor(r), 0); }

// Read pages in sequence: Supabase REST often caps a single response at 1000 rows.
async function buscarTodos(tipo) {
  const result = [];
  const pageSize = 500;
  for (let from = 0; ; from += pageSize) {
    const { data: rows, error } = await banco.from(SCHEMA[tipo].table)
      .select("*").order("id", { ascending: true }).range(from, from + pageSize - 1);
    if (error) throw error;
    result.push(...rows);
    if (rows.length < pageSize) break;
  }
  return result;
}
async function carregar() {
  const loadId = ++state.loadId;
  aviso("Carregando lançamentos...");
  try {
    const [receitas, despesas] = await Promise.all([buscarTodos("receita"), buscarTodos("despesa")]);
    if (loadId !== state.loadId) return;
    state.receitas = receitas;
    state.despesas = despesas;
    renderizar();
    aviso("");
  } catch (error) {
    if (loadId === state.loadId) aviso("Não foi possível carregar os lançamentos: " + error.message);
  }
}
function itemLancamento(r, tipo) {
  const item = document.createElement("article");
  item.className = "item";
  const info = document.createElement("div");
  const name = document.createElement("span");
  name.className = "item-name";
  name.textContent = descricao(r, tipo);
  const meta = document.createElement("span");
  meta.className = "item-meta";
  const [ano, mes, dia] = data(r).split("-");
  meta.textContent = [dia, mes, ano].filter(Boolean).join("/") + (tipo === "despesa" ? " · " + categoria(r) : "");
  info.append(name, meta);
  const right = document.createElement("div");
  right.className = "item-right";
  const amount = document.createElement("span");
  amount.className = "item-amount " + (tipo === "despesa" ? "expense" : "");
  amount.textContent = dinheiro(valor(r));
  const actions = document.createElement("div");
  actions.className = "item-actions";
  for (const [label, action] of [["Editar", () => editar(r, tipo)], ["Excluir", () => excluir(r, tipo)]]) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.setAttribute("aria-label", label + " " + descricao(r, tipo));
    button.addEventListener("click", action);
    actions.append(button);
  }
  right.append(amount, actions);
  item.append(info, right);
  return item;
}
function listar(rows, tipo) {
  const target = $(tipo === "receita" ? "listaReceitas" : "listaDespesas");
  target.replaceChildren();
  for (const r of rows.slice().sort((a, b) => data(b).localeCompare(data(a)) || Number(b.id) - Number(a.id)))
    target.append(itemLancamento(r, tipo));
  if (!rows.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "Nenhum lançamento neste mês.";
    target.append(empty);
  }
  $(tipo === "receita" ? "contagemReceitas" : "contagemDespesas").textContent = "(" + rows.length + ")";
}
function graficoCategorias(rows) {
  const chart = $("graficoCategorias");
  chart.replaceChildren();
  const totals = new Map();
  for (const row of rows) totals.set(categoria(row), (totals.get(categoria(row)) || 0) + valor(row));
  const entries = [...totals].sort((a, b) => b[1] - a[1]);
  if (!entries.length) { chart.textContent = "Cadastre despesas para ver a distribuição por categoria."; chart.classList.add("empty"); return; }
  chart.classList.remove("empty");
  const max = entries[0][1] || 1;
  for (const [name, amount] of entries) {
    const row = document.createElement("div"), label = document.createElement("div"), title = document.createElement("span"), number = document.createElement("strong"), track = document.createElement("div"), fill = document.createElement("div");
    row.className = "bar-row"; label.className = "bar-label"; track.className = "bar-track"; fill.className = "bar-fill";
    title.textContent = name; number.textContent = dinheiro(amount);
    fill.style.width = (amount / max * 100).toFixed(1) + "%";
    track.append(fill); label.append(title, number); row.append(label, track); chart.append(row);
  }
}
function graficoEvolucao(mes) {
  const chart = $("graficoEvolucao");
  chart.replaceChildren();
  const [ano, numero] = mes.split("-").map(Number);
  const months = Array.from({ length: 6 }, (_, i) => {
    const d = new Date(ano, numero - 1 - (5 - i), 1);
    return { key: d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0"),
      label: new Intl.DateTimeFormat("pt-BR", { month: "short", year: "2-digit" }).format(d) };
  });
  const values = months.map(m => [soma(registrosMes(state.receitas, m.key)), soma(registrosMes(state.despesas, m.key))]);
  const max = Math.max(1, ...values.flat());
  months.forEach((m, i) => {
    const group = document.createElement("div"), bars = document.createElement("div"), caption = document.createElement("small");
    group.className = "trend-group"; bars.className = "trend-bars"; caption.textContent = m.label;
    for (const [j, kind] of ["income", "expense"].entries()) {
      const bar = document.createElement("div");
      bar.className = "trend-bar " + kind;
      bar.style.height = (values[i][j] / max * 100).toFixed(1) + "%";
      bar.title = (j ? "Despesas: " : "Receitas: ") + dinheiro(values[i][j]);
      bar.setAttribute("aria-label", m.label + " — " + bar.title);
      bars.append(bar);
    }
    group.append(bars, caption); chart.append(group);
  });
}
function renderizar() {
  const mes = $("mes").value;
  const receitas = registrosMes(state.receitas, mes), despesas = registrosMes(state.despesas, mes);
  const saldo = soma(receitas) - soma(despesas);
  $("totalReceitas").textContent = dinheiro(soma(receitas));
  $("totalDespesas").textContent = dinheiro(soma(despesas));
  $("saldo").textContent = dinheiro(saldo);
  document.querySelector(".metric.featured").classList.toggle("negative", saldo < 0);
  listar(receitas, "receita"); listar(despesas, "despesa");
  graficoCategorias(despesas); graficoEvolucao(mes);
}
function editar(r, tipo) {
  state.editando = { id: r.id, tipo };
  selecionarTipo(tipo);
  $("descricao").value = descricao(r, tipo);
  $("valor").value = valor(r).toFixed(2);
  $("data").value = data(r);
  if (tipo === "despesa") {
    const select = $("categoria"), category = categoria(r);
    if (![...select.options].some(o => o.value === category)) select.add(new Option(category, category));
    select.value = category;
  }
  $("cancelar").hidden = false;
  $("descricao").focus();
  $("lancamentoForm").scrollIntoView({ behavior: "smooth", block: "center" });
}
async function confirmarExclusao(r, tipo) {
  const dialog = $("confirmacao");
  $("textoConfirmacao").textContent = "Deseja excluir “" + descricao(r, tipo) + "” (" + dinheiro(valor(r)) + ")? Esta ação não poderá ser desfeita.";
  return new Promise(resolve => {
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "confirm"), { once: true });
    dialog.showModal();
  });
}
async function excluir(r, tipo) {
  if (!await confirmarExclusao(r, tipo)) return;
  aviso("Excluindo lançamento...");
  const { data: removed, error } = await banco.from(SCHEMA[tipo].table).delete().eq("id", r.id).select("id");
  if (error || removed?.length !== 1) { aviso("Não foi possível excluir: " + (error?.message || "verifique sua permissão no banco.")); return; }
  if (state.editando?.id === r.id && state.editando?.tipo === tipo) cancelarEdicao();
  await carregar();
  aviso("Lançamento excluído.", true);
}
async function salvar(event) {
  event.preventDefault();
  const tipo = state.tipo, description = $("descricao").value.trim();
  const amount = Number($("valor").value), date = $("data").value;
  if (!description || !Number.isFinite(amount) || amount <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(date)) { aviso("Confira a descrição, o valor e a data."); return; }
  const payload = { [SCHEMA[tipo].description]: description, Valor: Math.round(amount * 100) / 100, Data: date };
  if (tipo === "despesa") payload.categoria = $("categoria").value;
  const editing = state.editando;
  $("salvar").disabled = true; aviso(editing ? "Salvando alterações..." : "Salvando lançamento...");
  try {
    let query = editing
      ? banco.from(SCHEMA[tipo].table).update(payload).eq("id", editing.id)
      : banco.from(SCHEMA[tipo].table).insert(payload);
    const { data: saved, error } = await query.select("id");
    if (error) throw error;
    if (saved?.length !== 1) throw new Error("O banco não confirmou a gravação. Confira as políticas de acesso.");
    cancelarEdicao();
    if (date.slice(0, 7) !== $("mes").value) $("mes").value = date.slice(0, 7);
    await carregar();
    aviso(editing ? "Lançamento atualizado." : "Lançamento cadastrado.", true);
  } catch (error) { aviso("Não foi possível salvar: " + error.message); }
  finally { $("salvar").disabled = false; }
}
function csvCell(value) {
  const text = String(value ?? "");
  // Spreadsheet applications interpret leading =,+,-,@ as formulas.
  const safe = /^[=+\-@\t\r]/.test(text) ? "'" + text : text;
  return '"' + safe.replaceAll('"', '""') + '"';
}
function exportarCsv() {
  const mes = $("mes").value;
  const rows = [
    ...registrosMes(state.receitas, mes).map(r => ["Receita", data(r), descricao(r, "receita"), "", valor(r)]),
    ...registrosMes(state.despesas, mes).map(r => ["Despesa", data(r), descricao(r, "despesa"), categoria(r), valor(r)])
  ].sort((a, b) => a[1].localeCompare(b[1]));
  const content = "\ufeff" + [["Tipo", "Data", "Descrição", "Categoria", "Valor (R$)"], ...rows.map(r => [...r.slice(0, 4), r[4].toFixed(2).replace(".", ",")])].map(r => r.map(csvCell).join(";")).join("\r\n");
  const url = URL.createObjectURL(new Blob([content], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a"); link.href = url; link.download = "orcamento-" + mes + ".csv";
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function entrar(event) {
  event.preventDefault();
  $("mensagemLogin").textContent = "Entrando...";
  const { error } = await banco.auth.signInWithPassword({ email: $("email").value.trim(), password: $("senha").value });
  $("senha").value = "";
  if (error) { $("mensagemLogin").textContent = "Não foi possível entrar. Confira seu e-mail e sua senha."; return; }
  $("mensagemLogin").textContent = "";
  mostrarAutenticacao(true); await carregar();
}
async function iniciar() {
  $("mes").value = hoje().slice(0, 7); $("data").value = hoje();
  $("loginForm").addEventListener("submit", entrar);
  $("lancamentoForm").addEventListener("submit", salvar);
  $("tipoDespesa").addEventListener("click", () => { cancelarEdicao(); selecionarTipo("despesa"); });
  $("tipoReceita").addEventListener("click", () => { cancelarEdicao(); selecionarTipo("receita"); });
  $("cancelar").addEventListener("click", cancelarEdicao);
  $("mes").addEventListener("change", renderizar);
  $("mesAtual").addEventListener("click", () => { $("mes").value = hoje().slice(0, 7); renderizar(); });
  $("atualizar").addEventListener("click", carregar);
  $("exportar").addEventListener("click", exportarCsv);
  $("sair").addEventListener("click", async () => { await banco.auth.signOut(); mostrarAutenticacao(false); cancelarEdicao(); });
  try {
    const { data, error } = await banco.auth.getSession();
    if (error) throw error;
    mostrarAutenticacao(Boolean(data.session));
    if (data.session) await carregar();
  } catch (error) { mostrarAutenticacao(false); $("mensagemLogin").textContent = "Não foi possível verificar a sessão. Tente entrar novamente."; }
}
iniciar();
