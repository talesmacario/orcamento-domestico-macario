// Runs independently of the CDN SDK, including when its download fails or stalls.
(() => {
  const status = document.getElementById("inicializacao");
  const message = document.getElementById("mensagemInicializacao");
  const retry = document.getElementById("tentarInicializacao");
  let finished = false;
  function fail() {
    if (finished) return;
    status.hidden = false;
    message.textContent = "Não foi possível iniciar o aplicativo. Verifique a conexão ou a disponibilidade do serviço e tente novamente.";
    retry.hidden = false;
  }
  const timer = setTimeout(fail, 15000);
  retry.addEventListener("click", () => location.reload());
  document.getElementById("supabaseSdk").addEventListener("error", fail);
  globalThis.appBootstrap = {
    fail,
    ready() { finished = true; clearTimeout(timer); status.hidden = true; }
  };
})();
