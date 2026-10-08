# Revisão da fase 1

As alterações desta fase são locais. Não exigem migration, alteração de RLS ou
publicação no GitHub Pages.

## Comportamento implementado

- Uma gravação confirmada limpa o formulário antes de atualizar as listas. Se a
  leitura falhar, o aplicativo informa que o lançamento foi gravado e que a tela
  ainda não foi atualizada. O botão **Atualizar** repete somente a leitura.
- Durante uma gravação, novos envios e ações de edição/exclusão ficam bloqueados.
  As mutações usam `retry(false)` para impedir reenvios automáticos pelo SDK.
- Se a resposta da gravação se perder, o resultado permanece incerto. Um marcador
  em `sessionStorage`, separado por usuário, preserva a referência UUID local,
  ação (cadastro/alteração/exclusão), tipo, registro quando conhecido, data,
  mês/ano e dados do lançamento para sua identificação. Ele preserva o bloqueio
  após recarregar a mesma aba. O UUID não é enviado como coluna ao banco e não
  constitui uma chave de idempotência do servidor.
- A conferência executa uma leitura paginada adicional, filtrada no Supabase por
  `Data >= primeiro dia do mês` e `Data < primeiro dia do próximo mês`, e exibe o
  período original da operação. Outra seleção de mês bloqueia a conferência;
  **Atualizar** volta a consultar e mostrar o período correto. Falhas nessa leitura
  não são compensadas por uma leitura bem-sucedida do histórico geral.
- Uma leitura vazia não resolve automaticamente uma operação incerta. É necessário
  conferir a lista do período correto e a identificação apresentada no diálogo,
  e informar explicitamente se confirmou que a operação foi ou não foi concluída
  para liberar o formulário. Escolher **Ainda não tenho certeza**, cancelar ou
  omitir o resultado mantém a pendência. Essa confirmação não envia nem repete
  uma gravação. A operação pode ainda estar em processamento.
- `onAuthStateChange` acompanha entrada, saída, renovação e troca de usuário.
  Consultas são adiadas para fora do callback síncrono do SDK. Respostas de sessões
  anteriores são descartadas. Ao sair, expirar a sessão ou trocar de conta, todos
  os diálogos são fechados como cancelados; descrições/valores dos diálogos,
  listas, totais, contagens, rascunhos, e-mail/senha e categorias adicionadas
  dinamicamente são limpos. A pendência armazenada permanece vinculada ao usuário
  que a criou e só é restaurada para esse mesmo usuário, permitindo a conferência
  posterior; seus dados não são mostrados à próxima conta.
- Erros distinguem credenciais, e-mail não confirmado, sessão expirada, conexão,
  indisponibilidade, excesso de tentativas e recusa da operação.
- Supabase JS está fixado em **2.117.3**, com integridade SHA-384 e CORS. Um bootstrap
  independente apresenta falhas de carregamento e timeout de 15 segundos, com
  ação para recarregar. A validação TLS permanece ativa.
- Valores, somas, saldo, categorias e CSV utilizam centavos inteiros em `BigInt`.
  A conversão decimal arredonda empates para longe de zero. Proporções visuais dos
  gráficos usam `Number`; os valores monetários exibidos não. O payload mantém
  `Valor` numérico e as colunas existentes. Novos lançamentos estão limitados a
  R$ 9.999.999.999,99 para preservar os centavos no JSON numérico existente.

## Testes unitários

Requer Node.js com suporte a `node:test` e `BigInt`. Não há dependências npm.

```sh
node tests/app.test.cjs
node tests/bootstrap.test.cjs
node --check app.js
node --check bootstrap.js
git diff --check
```

As respostas de autenticação e banco são simuladas. Inclusive os testes de
exclusão operam apenas sobre o mock, nunca sobre registros reais.

## Testes no Chromium

Requer Python 3, Playwright para Python e Chromium. No ambiente atual, ambos já
estão instalados. O SDK deve ser obtido com verificação TLS habilitada; seu hash
é conferido antes da execução. Não inclua o arquivo baixado no repositório.

```sh
curl --fail --silent --show-error --max-time 20 \
  https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.3/dist/umd/supabase.js \
  -o /tmp/macario-supabase-pinned.js
python tests/browser.test.py --sdk /tmp/macario-supabase-pinned.js -v
```

Defina `CHROMIUM_PATH` caso o executável não esteja em `/usr/bin/chromium`.
Os testes servem arquivos locais e interceptam todas as chamadas externas. Usam
o SDK verdadeiro, dados financeiros sintéticos e respostas em memória; nenhuma
requisição alcança o projeto Supabase. TLS não é ignorado. A flag `--no-sandbox`
é usada apenas no Chromium do executor de testes; não desativa verificação TLS.

## Limitações para revisão

- Idempotência global exige suporte do banco/servidor, fora desta etapa. O bloqueio
  local não cobre outras abas/dispositivos nem o encerramento/limpeza da sessão
  de armazenamento do navegador. Conferir uma resposta incerta não prova que uma
  operação ainda em processamento no servidor tenha terminado; a conferência
  deve considerar essa possibilidade antes de cadastrar novamente.
- Pendências antigas ou corrompidas sem identificação/período recuperáveis continuam
  bloqueadas; o aplicativo não presume que pertençam ao mês atualmente exibido.
  É necessário recuperar sua identificação antes de liberar a operação.
- Os testes não validam RLS, autenticação real ou persistência no Supabase.
  Os bloqueios de proxy e confiança TLS identificados no diagnóstico não foram
  alterados nesta fase. O SDK local nos testes permite verificar o frontend sem
  contornar esses bloqueios.
- O frontend não recupera precisão já perdida em dados numéricos existentes ou
  em uma eventual coluna de ponto flutuante no banco. Não houve alteração de tipos
  nem regravação de valores existentes.
- Valores legados com mais de duas casas decimais são arredondados por lançamento
  para os cálculos/exibição; seu conteúdo no banco permanece intacto.
- A versão do SDK continua hospedada em CDN. Falhas de CDN, certificado ou
  integridade geram a tela de recuperação; não há fallback que ignore segurança.
