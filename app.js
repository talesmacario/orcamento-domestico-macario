/* Only the Supabase publishable key belongs here. Authorization remains in Supabase RLS. */
const SUPABASE_URL = "https://jbglqcaeopuznaxmiuss.supabase.co";
const SUPABASE_KEY = "sb_publishable_sU-QdaTiWD_nRiqHz5lHLw_juyjRG8F";
let banco = null;
try {
  if (globalThis.supabase?.createClient) banco = globalThis.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
} catch { /* The independent bootstrap displays the startup failure below. */ }
const SCHEMA = {
  receita: { table: "Receitas", description: "Descrição" },
  despesa: { table: "Despesas", description: "Descricao" }
};
const $ = id => document.getElementById(id);
const moeda = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const state = { receitas: [], despesas: [], tipo: "despesa", editando: null, loadId: 0,
  userId: null, sessionVersion: 0, sessionEpoch: 0, writing: false, entering: false,
  pendingWrite: null, reviewReady: false, signingOut: false };
const PENDING_KEY = "macario.pending-write.v1";

function tipoErro(error) {
  const status = Number(error?.status || 0), code = error?.code;
  if (code === "invalid_credentials") return "credenciais";
  if (code === "email_not_confirmed") return "email";
  if (status === 401 || ["PGRST301", "PGRST302", "PGRST303", "session_not_found", "refresh_token_not_found", "refresh_token_already_used"].includes(code)) return "sessao";
  if (status === 429 || code === "over_request_rate_limit") return "limite";
  if (status >= 500) return "servico";
  if (error?.name === "AuthRetryableFetchError" || error instanceof TypeError || /failed to fetch|fetch failed|network|load failed|timeout/i.test(error?.message || "")) return "conexao";
  return "operacao";
}
function mensagemErro(error) {
  return {
    credenciais: "E-mail ou senha incorretos.", email: "Confirme seu e-mail antes de entrar.",
    sessao: "Sua sessão expirou. Entre novamente.", limite: "Muitas tentativas. Aguarde antes de tentar novamente.",
    servico: "O serviço está temporariamente indisponível. Tente novamente mais tarde.",
    conexao: "Não foi possível conectar ao serviço. Verifique sua conexão e tente novamente.",
    operacao: "A operação foi recusada. Verifique suas permissões e os dados informados."
  }[tipoErro(error)];
}
// Decimal arithmetic happens in integer cents. Floating point is used only for chart proportions.
function centavos(input) {
  let text = String(input ?? "0").trim();
  const scientific = /^([+-]?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(text);
  if (scientific) {
    const exponent = Number(scientific[4]);
    if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 100) throw new Error("Valor monetário inválido.");
    const digits = scientific[2] + (scientific[3] || ""), point = scientific[2].length + exponent;
    text = scientific[1] + (point <= 0 ? "0." + "0".repeat(-point) + digits
      : point >= digits.length ? digits + "0".repeat(point - digits.length)
      : digits.slice(0, point) + "." + digits.slice(point));
  }
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) throw new Error("Valor monetário inválido.");
  const fraction = match[3] || "";
  let result = BigInt(match[2]) * 100n + BigInt((fraction + "00").slice(0, 2));
  if (Number(fraction[2] || 0) >= 5) result++;
  return match[1] === "-" ? -result : result;
}
function decimal(cents) {
  const absolute = cents < 0n ? -cents : cents;
  return (cents < 0n ? "-" : "") + absolute / 100n + "." + String(absolute % 100n).padStart(2, "0");
}
function persistirPendencia(pending) {
  // If a write cannot be remembered across reloads, do not dispatch it.
  if (pending) sessionStorage.setItem(PENDING_KEY + "." + state.userId, JSON.stringify(pending));
  else sessionStorage.removeItem(PENDING_KEY + "." + state.userId);
  state.pendingWrite = pending;
  state.reviewReady = false;
  controlesGravacao();
}
function restaurarPendencia(userId) {
  try {
    const raw = sessionStorage.getItem(PENDING_KEY + "." + userId);
    const pending = raw === null ? null : JSON.parse(raw);
    state.pendingWrite = raw === null ? null : pending?.userId === userId ? pending : { userId, phase: "uncertain" };
  } catch { state.pendingWrite = { userId, phase: "uncertain" }; }
  state.reviewReady = false;
  controlesGravacao();
}
function periodoPendencia(pending = state.pendingWrite) {
  return typeof pending?.operationId === "string" && pending.operationId && SCHEMA[pending.tipo] && ["insert", "update", "delete"].includes(pending.action)
    && /^\d{4}-(0[1-9]|1[0-2])$/.test(pending.month || "")
    && typeof pending.entry?.date === "string" && /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(pending.entry.date)
    && typeof pending.entry.description === "string" && /^-?\d+\.\d{2}$/.test(pending.entry.amount || "")
    && pending.entry.date.slice(0, 7) === pending.month ? pending.month : null;
}
function podeConferir() {
  return !state.writing && state.reviewReady && state.pendingWrite?.phase === "uncertain"
    && periodoPendencia() === $("mes").value;
}
function controlesGravacao() {
  const blocked = state.writing || Boolean(state.pendingWrite);
  for (const id of ["salvar", "tipoReceita", "tipoDespesa", "cancelar", "descricao", "valor", "data", "categoria"])
    $(id).disabled = blocked;
  document.querySelectorAll(".item-actions button").forEach(button => { button.disabled = blocked; });
  $("revisarGravacao").hidden = state.pendingWrite?.phase !== "uncertain";
  $("revisarGravacao").disabled = !podeConferir();
}
function mensagemPendencia() {
  if (state.pendingWrite?.phase === "uncertain" && !periodoPendencia())
    return "A operação pendente não possui identificação e período recuperáveis. As gravações permanecem bloqueadas; não repita o lançamento sem esclarecer a operação.";
  const month = periodoPendencia();
  const period = month ? " Confira o período " + month.slice(5) + "/" + month.slice(0, 4) + "." : "";
  return state.pendingWrite?.phase === "confirmed"
    ? "Gravação concluída, mas a interface ainda não foi atualizada. Clique em Atualizar; não repita o lançamento."
    : "Não foi possível confirmar a gravação. Clique em Atualizar e confira os lançamentos antes de liberar novas gravações." + period;
}

function hoje() {
  // Date inputs and month filters must reflect the user's local day, not UTC.
  const d = new Date();
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0")].join("-");
}
function valor(r) { return centavos(r.Valor ?? "0"); }
function data(r) { return String(r.Data || "").slice(0, 10); }
function categoria(r) { return String(r.categoria || "Sem categoria"); }
function descricao(r, tipo) { return String(r[SCHEMA[tipo].description] || "Sem descrição"); }
function dinheiro(cents) {
  const absolute = cents < 0n ? -cents : cents;
  const whole = cents < 0n && absolute < 100n ? -0 : cents / 100n;
  return moeda.formatToParts(whole).map(part => part.type === "fraction"
    ? String(absolute % 100n).padStart(2, "0") : part.value).join("");
}
function aviso(message, ok = false) {
  $("mensagem").textContent = message;
  $("mensagem").classList.toggle("ok", ok);
}
function mostrarAutenticacao(logado) {
  $("painel").hidden = !logado;
  $("login").hidden = logado;
  if (!logado) {
    state.receitas = []; state.despesas = []; state.loadId++;
    state.reviewReady = false;
    document.querySelectorAll("dialog").forEach(dialog => {
      if (dialog.open) dialog.close("cancel");
      dialog.returnValue = "";
    });
    document.querySelectorAll("[data-financial-content]").forEach(element => { element.textContent = ""; });
    $("resultadoConferencia").value = "";
    $("categoria").querySelectorAll("[data-custom-category]").forEach(option => option.remove());
    cancelarEdicao();
    $("mes").value = hoje().slice(0, 7);
    $("email").value = ""; $("senha").value = "";
    $("listaReceitas").replaceChildren(); $("listaDespesas").replaceChildren();
    $("graficoCategorias").replaceChildren(); $("graficoEvolucao").replaceChildren();
    $("contagemReceitas").textContent = ""; $("contagemDespesas").textContent = "";
    aviso("");
    document.querySelector(".metric.featured").classList.remove("negative");
    for (const id of ["totalReceitas", "totalDespesas", "saldo"]) $(id).textContent = "—";
  }
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
function soma(rows) { return rows.reduce((acc, r) => acc + valor(r), 0n); }

// Read pages in sequence: Supabase REST often caps a single response at 1000 rows.
async function buscarTodos(tipo, month = null) {
  const result = [];
  const pageSize = 500;
  for (let from = 0; ; from += pageSize) {
    let query = banco.from(SCHEMA[tipo].table).select("*");
    if (month) {
      const [year, number] = month.split("-").map(Number);
      const next = String(number === 12 ? year + 1 : year).padStart(4, "0") + "-" + String(number === 12 ? 1 : number + 1).padStart(2, "0");
      query = query.gte("Data", month + "-01").lt("Data", next + "-01");
    }
    const { data: rows, error, status } = await query.order("id", { ascending: true }).range(from, from + pageSize - 1);
    if (error) throw { ...error, status: status ?? error.status };
    result.push(...rows);
    if (rows.length < pageSize) break;
  }
  return result;
}
async function carregar() {
  const loadId = ++state.loadId;
  state.reviewReady = false; controlesGravacao();
  aviso("Carregando lançamentos...");
  try {
    let [receitas, despesas] = await Promise.all([buscarTodos("receita"), buscarTodos("despesa")]);
    if (loadId !== state.loadId) return false;
    const pending = state.pendingWrite, month = periodoPendencia(pending);
    let reviewRows = null;
    if (pending?.phase === "uncertain" && month && !state.writing) {
      // A separate server-filtered read confirms the intended period, regardless of the visible month.
      reviewRows = await buscarTodos(pending.tipo, month);
      if (loadId !== state.loadId) return false;
      reviewRows.forEach(valor);
      const rows = pending.tipo === "receita" ? receitas : despesas;
      const refreshed = rows.filter(row => data(row).slice(0, 7) !== month).concat(reviewRows);
      if (pending.tipo === "receita") receitas = refreshed;
      else despesas = refreshed;
      $("mes").value = month;
    }
    // Validate before replacing the previously displayed state.
    receitas.forEach(valor); despesas.forEach(valor);
    if (pending?.phase === "confirmed" && month) $("mes").value = month;
    state.receitas = receitas;
    state.despesas = despesas;
    renderizar();
    if (state.pendingWrite?.phase === "confirmed") persistirPendencia(null);
    state.reviewReady = reviewRows !== null;
    controlesGravacao();
    aviso(state.pendingWrite ? mensagemPendencia() : "");
    return true;
  } catch (error) {
    if (loadId === state.loadId) {
      state.reviewReady = false; controlesGravacao();
      aviso((state.pendingWrite ? mensagemPendencia() + " " : "Não foi possível atualizar os lançamentos. ") + mensagemErro(error));
      if (tipoErro(error) === "sessao") invalidarSessao();
    }
    return false;
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
  for (const row of rows) totals.set(categoria(row), (totals.get(categoria(row)) || 0n) + valor(row));
  const entries = [...totals].sort((a, b) => a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : 0);
  if (!entries.length) { chart.textContent = "Cadastre despesas para ver a distribuição por categoria."; chart.classList.add("empty"); return; }
  chart.classList.remove("empty");
  const max = entries[0][1] || 1n;
  for (const [name, amount] of entries) {
    const row = document.createElement("div"), label = document.createElement("div"), title = document.createElement("span"), number = document.createElement("strong"), track = document.createElement("div"), fill = document.createElement("div");
    row.className = "bar-row"; label.className = "bar-label"; track.className = "bar-track"; fill.className = "bar-fill";
    title.textContent = name; number.textContent = dinheiro(amount);
    fill.style.width = (Number(amount) / Number(max) * 100).toFixed(1) + "%";
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
  const max = Math.max(1, ...values.flat().map(Number));
  months.forEach((m, i) => {
    const group = document.createElement("div"), bars = document.createElement("div"), caption = document.createElement("small");
    group.className = "trend-group"; bars.className = "trend-bars"; caption.textContent = m.label;
    for (const [j, kind] of ["income", "expense"].entries()) {
      const bar = document.createElement("div");
      bar.className = "trend-bar " + kind;
      bar.style.height = (Number(values[i][j]) / max * 100).toFixed(1) + "%";
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
  controlesGravacao();
}
function editar(r, tipo) {
  if (state.writing || state.pendingWrite) return;
  state.editando = { id: r.id, tipo };
  selecionarTipo(tipo);
  $("descricao").value = descricao(r, tipo);
  $("valor").value = decimal(valor(r));
  $("data").value = data(r);
  if (tipo === "despesa") {
    const select = $("categoria"), category = categoria(r);
    if (![...select.options].some(o => o.value === category)) {
      const option = new Option(category, category); option.setAttribute("data-custom-category", ""); select.add(option);
    }
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
    dialog.returnValue = "";
    dialog.showModal();
  });
}
async function executarGravacao(buildQuery, confirmado, mensagemSucesso, operation) {
  if (state.writing || state.pendingWrite || !state.userId) return;
  const epoch = state.sessionEpoch;
  const userId = state.userId;
  let dispatched = false, confirmed = false;
  state.writing = true; state.loadId++; controlesGravacao();
  aviso("Processando lançamento...");
  try {
    persistirPendencia({ ...operation, operationId: crypto.randomUUID(), userId: state.userId, phase: "uncertain",
      month: operation.entry.date.slice(0, 7) });
    dispatched = true;
    // Never replay a financial mutation automatically, including SDK retries.
    const { data: saved, error, status } = await buildQuery().select("id").retry(false);
    if (error) throw { ...error, status: status ?? error.status };
    if (saved?.length !== 1 || saved[0].id == null) throw { name: "UnconfirmedWriteError" };
    confirmed = true;
    if (epoch !== state.sessionEpoch) return;
    state.loadId++;
    state.pendingWrite = { ...state.pendingWrite, phase: "confirmed", recordId: saved[0].id };
    // Keep the in-memory confirmation even if storage becomes unavailable after dispatch.
    try { persistirPendencia(state.pendingWrite); } catch { /* Existing uncertain marker remains conservative. */ }
    confirmado();
    const updated = await carregar();
    if (epoch === state.sessionEpoch && updated) aviso(mensagemSucesso, true);
  } catch (error) {
    if (epoch !== state.sessionEpoch) return;
    if (confirmed) {
      aviso(mensagemPendencia());
    } else if (!dispatched) {
      aviso("Não foi possível iniciar a gravação com segurança. Verifique se o armazenamento da sessão está disponível.");
    } else if (!(Number(error?.status) >= 400 && Number(error?.status) < 500)) {
      state.loadId++; state.reviewReady = false;
      aviso(mensagemPendencia() + " " + mensagemErro(error));
    } else {
      // A definitive rejection is safe to retry after correcting the cause.
      try { persistirPendencia(null); } catch { state.pendingWrite = null; }
      aviso("Não foi possível gravar o lançamento. " + mensagemErro(error));
      if (tipoErro(error) === "sessao") invalidarSessao();
    }
  } finally {
    if (epoch !== state.sessionEpoch && userId === state.userId && state.pendingWrite?.phase === "uncertain") {
      state.loadId++; state.reviewReady = false;
    }
    state.writing = false; controlesGravacao();
  }
}
async function excluir(r, tipo) {
  if (state.writing || state.pendingWrite || !state.userId) return;
  const epoch = state.sessionEpoch;
  if (!await confirmarExclusao(r, tipo)) return;
  if (epoch !== state.sessionEpoch) return;
  await executarGravacao(
    () => banco.from(SCHEMA[tipo].table).delete().eq("id", r.id),
    () => { if (state.editando?.id === r.id && state.editando?.tipo === tipo) cancelarEdicao(); },
    "Lançamento excluído.",
    { action: "delete", tipo, recordId: r.id,
      entry: { date: data(r), description: descricao(r, tipo), amount: decimal(valor(r)), category: tipo === "despesa" ? categoria(r) : "" } }
  );
}
async function salvar(event) {
  event.preventDefault();
  if (state.writing || state.pendingWrite || !state.userId) return;
  const tipo = state.tipo, description = $("descricao").value.trim(), date = $("data").value;
  let amount;
  try { amount = centavos($("valor").value); } catch { amount = 0n; }
  // This bound preserves each cent in the existing numeric JSON payload and rejects excessive inputs.
  if (!description || amount <= 0n || amount > 999999999999n || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    aviso("Confira a descrição, o valor (até R$ 9.999.999.999,99) e a data."); return;
  }
  const payload = { [SCHEMA[tipo].description]: description, Valor: Number(decimal(amount)), Data: date };
  if (tipo === "despesa") payload.categoria = $("categoria").value;
  const editing = state.editando;
  await executarGravacao(
    () => editing ? banco.from(SCHEMA[tipo].table).update(payload).eq("id", editing.id)
      : banco.from(SCHEMA[tipo].table).insert(payload),
    () => {
      cancelarEdicao();
      if (date.slice(0, 7) !== $("mes").value) $("mes").value = date.slice(0, 7);
    },
    editing ? "Lançamento atualizado." : "Lançamento cadastrado.",
    { action: editing ? "update" : "insert", tipo, recordId: editing?.id ?? null,
      entry: { date, description, amount: decimal(amount), category: tipo === "despesa" ? payload.categoria : "" } }
  );
}
async function revisarGravacao() {
  if (!podeConferir()) return;
  const epoch = state.sessionEpoch, dialog = $("conferenciaGravacao");
  const pending = state.pendingWrite, loadId = state.loadId;
  const entry = pending.entry, [year, month, day] = entry.date.split("-");
  const action = { insert: "Cadastro", update: "Alteração", delete: "Exclusão" }[pending.action];
  $("resultadoConferencia").value = "";
  $("textoConferencia").textContent = action + " de " + pending.tipo + ": “" + entry.description + "” ("
    + dinheiro(centavos(entry.amount)) + "), em " + day + "/" + month + "/" + year
    + (entry.category ? ", categoria " + entry.category : "") + ". Referência: " + pending.operationId
    + (pending.recordId != null ? ", registro " + pending.recordId : "")
    + ". Confira os lançamentos de " + month + "/" + year + ". Uma lista vazia ou um registro parecido não prova o resultado; a operação pode ainda estar em processamento. Continue apenas depois de conferir o resultado. Não repita um lançamento já salvo.";
  const confirmed = await new Promise(resolve => {
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "confirm"), { once: true });
    dialog.returnValue = "";
    dialog.showModal();
  });
  if (!confirmed || epoch !== state.sessionEpoch || loadId !== state.loadId || state.pendingWrite !== pending || !podeConferir()) return;
  const resolution = $("resultadoConferencia").value;
  if (!["completed", "not-completed"].includes(resolution)) {
    aviso("O resultado continua incerto. A operação permanece pendente; atualize e confira novamente antes de repetir o lançamento.");
    return;
  }
  try {
    persistirPendencia(null); cancelarEdicao();
    aviso(resolution === "completed"
      ? "Conferência concluída: operação já concluída. Não repita esse lançamento."
      : "Conferência concluída: você confirmou que a operação não foi concluída. Se necessário, tente novamente.");
  } catch { aviso("Não foi possível liberar as gravações com segurança. Tente novamente."); }
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
  const content = "\ufeff" + [["Tipo", "Data", "Descrição", "Categoria", "Valor (R$)"], ...rows.map(r => [...r.slice(0, 4), decimal(r[4]).replace(".", ",")])].map(r => r.map(csvCell).join(";")).join("\r\n");
  const url = URL.createObjectURL(new Blob([content], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a"); link.href = url; link.download = "orcamento-" + mes + ".csv";
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function aplicarSessao(session) {
  const userId = session?.user?.id || null;
  if (userId === state.userId) {
    if (!userId) mostrarAutenticacao(false);
    return;
  }
  state.sessionEpoch++; state.loadId++;
  state.userId = userId;
  mostrarAutenticacao(false);
  state.pendingWrite = null; state.reviewReady = false;
  if (!userId) {
    controlesGravacao();
    if (!state.signingOut) $("mensagemLogin").textContent = "Sua sessão terminou. Entre novamente.";
    return;
  }
  restaurarPendencia(userId);
  mostrarAutenticacao(true); $("mensagemLogin").textContent = "";
  // Do not call Supabase methods inside the synchronous auth callback (SDK lock).
  const epoch = state.sessionEpoch;
  setTimeout(() => { if (epoch === state.sessionEpoch) void carregar(); }, 0);
}
function invalidarSessao() {
  aplicarSessao(null);
  $("mensagemLogin").textContent = "Sua sessão expirou. Entre novamente.";
  const epoch = state.sessionEpoch;
  // Deferred to avoid re-entering the SDK auth lock.
  setTimeout(() => {
    if (epoch === state.sessionEpoch) void banco.auth.signOut({ scope: "local" }).catch(() => {});
  }, 0);
}
async function entrar(event) {
  event.preventDefault();
  if (state.entering) return;
  state.entering = true; $("entrar").disabled = true;
  const version = state.sessionVersion;
  $("mensagemLogin").textContent = "Entrando...";
  try {
    const { data, error } = await banco.auth.signInWithPassword({ email: $("email").value.trim(), password: $("senha").value });
    if (error) throw error;
    if (!data?.session) throw { code: "session_not_found" };
    if (version !== state.sessionVersion && state.userId !== data.session.user.id) return;
    aplicarSessao(data.session);
    $("mensagemLogin").textContent = "";
  } catch (error) { $("mensagemLogin").textContent = mensagemErro(error); }
  finally { $("senha").value = ""; state.entering = false; $("entrar").disabled = false; }
}
async function sair() {
  if (state.signingOut) return;
  state.signingOut = true; $("sair").disabled = true;
  try {
    const { error } = await banco.auth.signOut();
    if (error) throw error;
    aplicarSessao(null); $("mensagemLogin").textContent = "";
  } catch (error) { aviso("Não foi possível sair da conta. " + mensagemErro(error)); }
  finally { state.signingOut = false; $("sair").disabled = false; }
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
  $("revisarGravacao").addEventListener("click", revisarGravacao);
  $("exportar").addEventListener("click", exportarCsv);
  $("sair").addEventListener("click", sair);
  banco.auth.onAuthStateChange((_event, session) => {
    state.sessionVersion++;
    aplicarSessao(session);
  });
  const version = state.sessionVersion;
  try {
    const { data, error } = await banco.auth.getSession();
    if (version !== state.sessionVersion) return;
    if (error) throw error;
    aplicarSessao(data.session);
    if (!data.session) mostrarAutenticacao(false);
  } catch (error) {
    if (version !== state.sessionVersion) return;
    aplicarSessao(null); mostrarAutenticacao(false);
    $("mensagemLogin").textContent = mensagemErro(error);
  }
}
if (banco) {
  globalThis.appBootstrap?.ready();
  iniciar();
} else {
  globalThis.appBootstrap?.fail();
}
