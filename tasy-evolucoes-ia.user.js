// ==UserScript==
// @name         Tasy - Evolucoes + IA (correcao e relatorio)
// @namespace    local.thales.evolucoes.ia
// @version      2.5.0
// @description  Os botoes do script antigo (Copiar + TXT, Baixar XLS) mais o botao Relatorio IA: com uma chave de API (Claude, OpenAI ou Gemini) gera num so clique o relatorio medico a partir das notas mais recentes, em TXT e na area de transferencia (evolucoes corrigidas opcionais).
// @match        https://tasy.hospitaldeamor.com.br/*
// @grant        GM_setClipboard
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      api.openai.com
// @connect      generativelanguage.googleapis.com
// @connect      api.anthropic.com
// @run-at       document-idle
// ==/UserScript==

/*
  Convive com o script antigo "Tasy - Exportar todas as evolucoes em XLS"
  (v1.3.0): ids e nomes diferentes, os dois podem ficar ativos ao mesmo tempo.

  A CHAVE DA API E DE CADA MEDICO: fica so no Tampermonkey deste navegador
  (GM_setValue), nunca sai para outro lugar. Configurar pelo menu do
  Tampermonkey (icone da extensao > este script > "Configurar IA...").

  Privacidade: o bloco IDENTIFICACAO (atendimento, prontuario, nascimento...)
  e os dados da linha (profissional, conselho) NAO sao enviados a IA; so vao
  data da nota e o texto da evolucao. O prompt proibe citar nome de paciente.
  Sem chave configurada, o botao gera o "pacote" (prompt + evolucoes) para
  colar em qualquer IA de chat.
*/

(function () {
  'use strict';

  const DATA_HORA = /^\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}:\d{2}$/;
  const LIMITE_CARACTERES_IA = 90000; // acima disso a IA recebe so as notas mais recentes

  const esperar = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const texto = (valor) => String(valor || '')
    .replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const textoConteudo = (valor) => String(valor || '')
    .replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '')
    .replace(/\u00A0/g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  // ------------------------------------------------------------------ IA: config

  // Modelos padrao sao editaveis no menu "Configurar IA...". Teste de 28/09/2026
  // (caso ficticio, mesmos prompts): claude-sonnet-5-5 cumpriu o roteiro inteiro em
  // 7,9 s (padrao); gpt-6-sol 11 s, pulou riscos; gpt-6-luna 7 s, mais raso mas
  // 20x mais barato. Precos US$ por 1M tokens entrada/saida: sonnet 2/10,
  // sol 2/10, luna 0,10/0,50, gemini-3.8-flash nao conferido.
  const PROVEDOR_PADRAO = 'anthropic';
  const PROVEDORES = {
    anthropic: {
      nome: 'Anthropic (Claude)',
      modeloPadrao: 'claude-sonnet-5-5',
      url: () => 'https://api.anthropic.com/v1/messages',
    },
    openai: {
      nome: 'OpenAI',
      modeloPadrao: 'gpt-6-luna',
      url: () => 'https://api.openai.com/v1/chat/completions',
    },
    gemini: {
      nome: 'Google Gemini',
      modeloPadrao: 'gemini-3.8-flash',
      url: (modelo, chave) =>
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelo)}:generateContent?key=${encodeURIComponent(chave)}`,
    },
  };

  function configIA() {
    const provedor = GM_getValue('ia_provedor', PROVEDOR_PADRAO);
    const info = PROVEDORES[provedor] || PROVEDORES[PROVEDOR_PADRAO];
    return {
      provedor: PROVEDORES[provedor] ? provedor : PROVEDOR_PADRAO,
      chave: String(GM_getValue('ia_chave', '') || '').trim(),
      modelo: String(GM_getValue('ia_modelo', '') || '').trim() || info.modeloPadrao,
      // Anthropic: chave de organizacao (sem workspace) exige este header
      workspace: String(GM_getValue('ia_workspace', '') || '').trim(),
      gerarRelatorio: GM_getValue('ia_relatorio', true),
      gerarCorrecao: GM_getValue('ia_correcao', false),   // opcional: dobra o tempo
      // opcional (desligado): so notas "Evolução Médica"; por padrao vai o que o
      // filtro do proprio Tasy estiver mostrando
      soMedicas: GM_getValue('ia_so_medicas', false),
      // quantas notas (as mais recentes) vao para a IA; 0 = todas. 26 notas
      // levaram ~1 min em 29/09/2026; 10 basta para o relatorio
      maxNotas: Number(GM_getValue('ia_max_notas', 10)) || 0,
    };
  }

  function configurarIA() {
    const atual = configIA();
    const provedor = prompt(
      'Provedor de IA: digite "anthropic" (padrao, Claude Sonnet 5.5: melhor no teste), "openai" (gpt-6-luna: mais barato) ou "gemini".',
      atual.provedor);
    if (provedor === null) return;
    const escolhido = PROVEDORES[texto(provedor).toLowerCase()] ? texto(provedor).toLowerCase() : PROVEDOR_PADRAO;
    GM_setValue('ia_provedor', escolhido);

    const chave = prompt(
      `Chave da API ${PROVEDORES[escolhido].nome} (fica so neste navegador). ` +
      'Deixe em branco para manter a atual.',
      '');
    if (chave === null) return;
    if (texto(chave)) GM_setValue('ia_chave', texto(chave));

    const modelo = prompt(
      `Modelo (Enter para o padrao ${PROVEDORES[escolhido].modeloPadrao}).`,
      GM_getValue('ia_modelo', '') || PROVEDORES[escolhido].modeloPadrao);
    if (modelo === null) return;
    GM_setValue('ia_modelo', texto(modelo) === PROVEDORES[escolhido].modeloPadrao ? '' : texto(modelo));

    if (escolhido === 'anthropic') {
      const ws = prompt(
        'ID do workspace da Anthropic (wrkspc_...). Obrigatorio se a chave for da organizacao ' +
        '(erro "not scoped to a workspace"); deixe em branco se a chave ja for de um workspace.',
        GM_getValue('ia_workspace', ''));
      if (ws !== null) GM_setValue('ia_workspace', texto(ws));
    }

    alert(`IA configurada: ${PROVEDORES[escolhido].nome}, modelo ${configIA().modelo}` +
      (configIA().chave ? '.' : '. ATENCAO: ainda sem chave; o botao vai gerar so o pacote para colar numa IA.'));
    atualizarBotoes();
  }

  function apagarChave() {
    if (!confirm('Apagar a chave de IA guardada neste navegador?')) return;
    GM_setValue('ia_chave', '');
    alert('Chave apagada.');
    atualizarBotoes();
  }

  function escolherSaidas() {
    const rel = confirm('Gerar RELATORIO MEDICO (INSS) com a IA?\n\nOK = sim, Cancelar = nao.');
    GM_setValue('ia_relatorio', rel);
    const cor = confirm('Gerar EVOLUCOES CORRIGIDAS (portugues, sem mudar o conteudo) com a IA?\n\nOK = sim, Cancelar = nao.');
    GM_setValue('ia_correcao', cor);
    const med = confirm('Mandar a IA SO as notas do tipo "Evolução Médica"?\n\nOK = sim (enfermagem/farmacia ficam fora), Cancelar = nao (vai tudo que o filtro do Tasy mostra).');
    GM_setValue('ia_so_medicas', med);
    const max = prompt('Quantas notas (as mais recentes) mandar para a IA? 0 = todas.',
      String(GM_getValue('ia_max_notas', 10)));
    if (max !== null && /^\d+$/.test(texto(max))) GM_setValue('ia_max_notas', Number(texto(max)));
    const cfg = configIA();
    alert(`Saidas: relatorio ${rel ? 'SIM' : 'NAO'}, evolucoes corrigidas ${cor ? 'SIM' : 'NAO'}, ` +
      `so evolucoes medicas ${med ? 'SIM' : 'NAO'}, notas para a IA: ${cfg.maxNotas || 'todas'}.`);
  }

  /** Botao de engrenagem na barra do Tasy: o menu do Tampermonkey nao aparece
   *  na janela do prontuario ("nao possui acesso a esta pagina"). */
  async function menuConfiguracao() {
    const cfg = configIA();
    const opcao = prompt(
      `IA: ${PROVEDORES[cfg.provedor].nome}, ${cfg.modelo}, chave ${cfg.chave ? 'configurada' : 'AUSENTE'}.\n\n` +
      'Digite o numero:\n1 = Configurar IA (provedor, chave, modelo)\n2 = Testar chave\n' +
      '3 = Escolher saidas (relatorio / correcao / so medicas)\n4 = Apagar chave', '1');
    if (opcao === null) return;
    const acao = { 1: configurarIA, 2: testarChave, 3: escolherSaidas, 4: apagarChave }[texto(opcao)];
    if (acao) await acao();
  }

  async function testarChave() {
    const cfg = configIA();
    if (!cfg.chave) { alert('Nenhuma chave configurada. Use "Configurar IA...".'); return; }
    try {
      const resposta = await chamarIA(cfg, 'Responda apenas: ok', 'teste', { rapido: true });
      alert(`Chave funcionando (${PROVEDORES[cfg.provedor].nome}, ${cfg.modelo}). Resposta: ${texto(resposta).slice(0, 40)}`);
    } catch (erro) {
      alert(`Falhou: ${erro.message}`);
    }
  }

  GM_registerMenuCommand('Configurar IA (provedor, chave, modelo)...', configurarIA);
  GM_registerMenuCommand('Escolher saidas (relatorio / correcao)...', escolherSaidas);
  GM_registerMenuCommand('Testar chave da IA', testarChave);
  GM_registerMenuCommand('Apagar chave da IA', apagarChave);

  // ------------------------------------------------------------------ IA: prompts

  // Prompt-base do relatorio previdenciario (RELATORIO_INSS_MAIS_ATUAL-13-08-2026)
  // + regras de estilo e roteiro de conteudo usados no sistema de receitas.
  const PROMPT_RELATORIO = [
    'Elabore relatório neurológico conciso, técnico, natural e direto ao ponto. Priorize cronologia com datas, achados alterados de neuroimagem, LCR, AP e sorologias relevantes.',
    'No exame neurológico, descreva apenas os déficits presentes na última avaliação, usando siglas habituais da Neurologia. Destaque repercussão funcional objetiva sobre fala, deglutição, coordenação, destreza manual, marcha e AVDs. Evite repetir achados normais, hipóteses extensas ou explicações desnecessárias.',
    'Foque na incapacidade, frequência de crise, na perspectiva de seguimento. Use as abreviações padrões. Sempre colocar CID no final. Nunca coloque o que NÃO está (ex.: "Não há LCR ou sorologias relevantes documentados"). Foque em resultados objetivos de exames e em diagnósticos definitivos da neurologia. NÃO USAR BULLETS NEM HIFENS.',
    '',
    'REGRAS ABSOLUTAS DE ESTILO: nunca use travessões (— ou –); nunca use bullets, listas ou hifens de tópico; escreva em parágrafos corridos; português técnico e neutro, sem termos rebuscados; nunca dê parecer sobre concessão de benefício; nunca afirme que algo "não foi encontrado" ou "não está disponível"; evite palavras vagas como "manejo", "em investigação", "complexo", "abordagem", "otimização": prefira o termo concreto do que foi feito ou observado. PROIBIDO frases genéricas que caberiam em qualquer relatório ("necessita seguimento especializado", "perda funcional relevante", "comprometimento importante", "impacto significativo"): substitua por dados objetivos, mensuráveis e específicos deste caso (o que o paciente não consegue fazer, com que frequência, desde quando).',
    '',
    'ROTEIRO OBRIGATÓRIO DO CONTEÚDO (em parágrafos corridos, sem títulos, sem listas), cada ponto explícito quando os dados o sustentarem: (a) DÉFICITS: cada déficit neurológico presente no último exame, nomeado e graduado, com a data da avaliação. (b) INCAPACIDADES: o que o paciente NÃO consegue fazer por causa desses déficits, em atividades concretas, com frequência e desde quando, e a repercussão laboral quando descrita. (c) EPILEPSIA, quando houver: tipo de crise, frequência atual e anterior, data da última crise, aura ou perda de consciência, controle parcial ou refratário, fármacos que já falharam, restrições decorrentes (dirigir, altura, máquinas, fogo, turnos noturnos, ficar sozinho). (d) RISCOS: queda, crise no trabalho, acidente, piora com esforço ou privação de sono, sonolência pela medicação. (e) MEDICAÇÕES ATUAIS: cada fármaco em uso com dose e posologia, pela nota mais recente; efeitos adversos documentados. (f) PROGNÓSTICO E SEGUIMENTO: caráter crônico ou progressivo, perspectiva de melhora documentada e intervalo de retorno. Ponto sem dado no prontuário é simplesmente omitido, nunca preenchido com suposição nem com "não documentado".',
    '',
    'REGRAS FINAIS (prevalecem sobre qualquer instrução anterior): (1) As evoluções recebidas são a ÚNICA fonte da clínica; não invente diagnóstico, dose, data ou exame. (2) NUNCA cite nome de paciente, de familiar ou de profissional no texto; a identificação sai no cabeçalho do documento. (3) Encerramento: no máximo "Mantém seguimento neurológico com retorno programado, sem alta até o momento." (4) Termine com a linha "CID-10: código, descrição curta" (1 a 3 CIDs, um por linha). (5) Devolva só o relatório, sem título, sem comentários, sem markdown.',
  ].join('\n');

  // Correcao das evolucoes: mesmo texto, mesma estrutura, portugues certo.
  const PROMPT_CORRECAO = [
    'Você recebe evoluções clínicas de neurologia copiadas de um prontuário eletrônico, cada uma iniciada por uma linha "### EVOLUÇÃO n, data". Devolva as MESMAS evoluções, na MESMA ordem, cada uma iniciada pela MESMA linha "### EVOLUÇÃO n, data" inalterada, corrigindo apenas: erros de ortografia, acentuação, digitação, concordância, pontuação e transcrição de voz; grafia de fármacos, doses e siglas; frases truncadas que precisam de conector para ficar legíveis.',
    'NUNCA acrescente informação, hipótese, conclusão, dado ou frase; NUNCA remova dado clínico, número, data, dose, exame ou conduta; NUNCA resuma, reorganize ou junte evoluções; mantenha as quebras de linha, os rótulos (HMA, EF, HD, CD, MEDICAÇÕES etc.), as siglas e o estilo telegráfico do médico quando existir. Português do Brasil. Não use markdown além da linha "### EVOLUÇÃO". Não cite nome de paciente: se aparecer um nome de paciente ou familiar, substitua por "o paciente" ou "familiar". Devolva só o texto corrigido, inteiro.',
  ].join('\n');

  // Resumo do caso (pedido do medico, 29/09/2026): texto pronto para colar no
  // topo da evolucao, no formato de secoes "# Titulo" que ele ja usa. Historico
  // neuro direto; parte onco/hemato didatica (nao e a area dele); HD por ultimo,
  // com a impressao concisa. Sem "PARTE 1/2", sem roteiro rigido.
  const PROMPT_RESUMO = [
    'Você recebe evoluções clínicas de neurologia de um prontuário, da mais recente para a mais antiga. Escreva o resumo do caso para ficar no topo da próxima evolução, do jeito que um neurologista escreve para si mesmo. Use só o que está nas evoluções e só o que é seguro (mais de 90% de certeza); na dúvida, omita. Não invente, não complete lacunas.',
    'Formato: seções curtas, cada uma iniciada por uma linha "# Título" (sem outro markdown). Primeira linha é a área do caso (ex.: "# NEURO-ONCOLOGIA", "# CEFALEIA", "# EPILEPSIA"). Depois, nesta ordem, só as seções que fizerem sentido para o caso:',
    '# Histórico: a parte neurológica, bem direta, em ordem cronológica com datas (mês/ano), doses e resposta: o que falhou, o que foi intolerado, o que funcionou, procedimentos e o estado atual. Siglas habituais da neurologia, frases curtas, sem explicar o óbvio.',
    '# Resumo oncológico (ou hematológico, reumatológico, endócrino etc., quando houver doença de base de outra área): aqui seja didático, porque não é a área do leitor. Diga o tipo de tumor ou doença, estadiamento e marcadores com o significado prático, tratamentos feitos com datas, situação atual (remissão, recidiva, em tratamento), o que vigiar do ponto de vista neurológico (metástase, paraneoplásico, toxicidade de quimioterápico ou imunoterapia, efeitos da radioterapia) e o que os exames mostram. Explique siglas e termos da outra área na primeira vez.',
    '# Exames relevantes: só os alterados ou os que definem conduta, com data. Termine com o que está pendente ou agendado.',
    '# HD: por último. Sua impressão, concisa: as hipóteses principais (no máximo 3), uma por linha iniciada por hífen, cada uma com no máximo uma frase de justificativa cruzando clínica e exame. Aponte contradições entre as evoluções quando existirem.',
    'Sem travessões. Não cite nome de paciente, familiar ou profissional. Devolva só o texto, sem comentários.',
  ].join('\n');

  // ------------------------------------------------------------------ IA: chamada

  function requisicao(url, corpo, cabecalhos, timeoutMs) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url,
        headers: { 'Content-Type': 'application/json', ...cabecalhos },
        data: JSON.stringify(corpo),
        timeout: timeoutMs,
        onload: (r) => {
          if (r.status >= 200 && r.status < 300) {
            try { resolve(JSON.parse(r.responseText)); } catch (e) { reject(new Error('Resposta da IA nao e JSON')); }
          } else {
            let detalhe = '';
            try { detalhe = JSON.parse(r.responseText).error?.message || ''; } catch (_) { detalhe = String(r.responseText || '').slice(0, 200); }
            reject(new Error(`IA respondeu ${r.status}${detalhe ? `: ${detalhe}` : ''}`));
          }
        },
        onerror: () => reject(new Error('Falha de rede ao chamar a IA (verifique @connect / internet)')),
        ontimeout: () => reject(new Error('A IA demorou demais (timeout)')),
      });
    });
  }

  async function chamarIA(cfg, sistema, usuario, opcoes = {}) {
    const timeoutMs = opcoes.rapido ? 30000 : 240000;
    if (cfg.provedor === 'openai') {
      const corpo = {
        model: cfg.modelo,
        messages: [{ role: 'system', content: sistema }, { role: 'user', content: usuario }],
      };
      // modelos de raciocinio (gpt-5.x, o-series) aceitam reasoning_effort e nao aceitam temperature
      if (/^(gpt-[5-9]|o\d)/i.test(cfg.modelo)) corpo.reasoning_effort = 'low';
      else corpo.temperature = 0.2;
      const dados = await requisicao(PROVEDORES.openai.url(), corpo,
        { Authorization: `Bearer ${cfg.chave}` }, timeoutMs);
      const saida = dados.choices?.[0]?.message?.content;
      if (!saida) throw new Error('OpenAI devolveu resposta vazia');
      return saida;
    }
    if (cfg.provedor === 'anthropic') {
      const corpo = {
        model: cfg.modelo,
        max_tokens: 16000,
        system: sistema,
        messages: [{ role: 'user', content: usuario }],
        output_config: { effort: 'low' },
      };
      const cabecalhos = {
        'x-api-key': cfg.chave,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      };
      if (cfg.workspace) cabecalhos['anthropic-workspace-id'] = cfg.workspace;
      const dados = await requisicao(PROVEDORES.anthropic.url(), corpo, cabecalhos, timeoutMs);
      if (dados.stop_reason === 'refusal') throw new Error('Claude recusou a solicitacao');
      const saida = (dados.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
      if (!saida) throw new Error('Claude devolveu resposta vazia');
      return saida;
    }
    const corpo = {
      system_instruction: { parts: [{ text: sistema }] },
      contents: [{ role: 'user', parts: [{ text: usuario }] }],
      generationConfig: { temperature: 0.2 },
    };
    const dados = await requisicao(PROVEDORES.gemini.url(cfg.modelo, cfg.chave), corpo, {}, timeoutMs);
    const partes = dados.candidates?.[0]?.content?.parts || [];
    const saida = partes.map((p) => p.text || '').join('');
    if (!saida) {
      const motivo = dados.candidates?.[0]?.finishReason || dados.promptFeedback?.blockReason || '';
      throw new Error(`Gemini devolveu resposta vazia${motivo ? ` (${motivo})` : ''}`);
    }
    return saida;
  }

  const limparSaida = (t) => String(t || '')
    .replace(/^```[a-z]*\s*|\s*```$/g, '')
    .replace(/(?<=\d)\s*[—–]\s*(?=\d)/g, '-')
    .replace(/\s*[—–]\s*/g, ', ')
    .trim();

  // ------------------------------------------------------------------ DOM Tasy
  // (identico ao script v1.3.0, que ja esta validado na tela de Notas clinicas)

  // Ajuste estes valores apenas se o sistema ou a rede estiverem lentos (XLS).
  const PAUSA_SELECAO_MS = 300;
  const PAUSA_MENU_MS = 100;
  const PAUSA_DOWNLOAD_MS = 700;

  let executando = false;
  let cancelar = false;
  let botaoCopiar;
  let botaoXls;
  let botaoIA;
  let botaoResumo;
  let grupoBotoes;
  let painel;

  function clicar(elemento) {
    elemento.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const JanelaMouseEvent = elemento.ownerDocument.defaultView.MouseEvent;
    elemento.dispatchEvent(new JanelaMouseEvent('mousedown', { bubbles: true }));
    elemento.dispatchEvent(new JanelaMouseEvent('mouseup', { bubbles: true }));
    elemento.click();
  }

  function acharComando(rotulos) {
    const opcoes = Array.isArray(rotulos) ? rotulos : [rotulos];
    const seletores = ['button', 'a', 'li', '[role="button"]', '[role="menuitem"]', 'span', 'div'].join(',');
    return [...document.querySelectorAll(seletores)]
      .filter((el) => visivel(el) && opcoes.includes(texto(el.innerText)))
      .sort((a, b) => {
        const caixaA = a.getBoundingClientRect();
        const caixaB = b.getBoundingClientRect();
        return caixaA.width * caixaA.height - caixaB.width * caixaB.height;
      })[0];
  }

  async function esperarComando(rotulos, limiteMs = 1500) {
    const inicio = Date.now();
    while (Date.now() - inicio < limiteMs) {
      const encontrado = acharComando(rotulos);
      if (encontrado) return encontrado;
      await esperar(40);
    }
    const nomes = Array.isArray(rotulos) ? rotulos.join(' / ') : rotulos;
    throw new Error(`Comando nao encontrado: ${nomes}`);
  }

  function visivel(elemento) {
    if (!elemento || elemento.nodeType !== Node.ELEMENT_NODE) return false;
    const estilo = getComputedStyle(elemento);
    const caixa = elemento.getBoundingClientRect();
    return (
      estilo.display !== 'none' &&
      estilo.visibility !== 'hidden' &&
      Number(estilo.opacity) !== 0 &&
      caixa.width > 0 &&
      caixa.height > 0
    );
  }

  function clicarLinha(item, usarCelulaData = false) {
    const celulas = [...item.linha.querySelectorAll('td, [role="gridcell"]')];
    const atendimento = celulas.find((celula) => /^\d{5,10}$/.test(texto(celula.innerText)));
    const alvo = usarCelulaData ? item.elemento : (atendimento || item.linha || item.elemento);
    const caixa = alvo.getBoundingClientRect();
    const janelaPagina = alvo.ownerDocument.defaultView;
    const opcoes = {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: caixa.left + Math.min(caixa.width / 2, 20),
      clientY: caixa.top + caixa.height / 2
    };

    alvo.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    if (typeof alvo.focus === 'function') alvo.focus({ preventScroll: true });
    if (typeof janelaPagina.PointerEvent === 'function') {
      alvo.dispatchEvent(new janelaPagina.PointerEvent('pointerdown', { ...opcoes, pointerId: 1, isPrimary: true }));
    }
    alvo.dispatchEvent(new janelaPagina.MouseEvent('mousedown', opcoes));
    if (typeof janelaPagina.PointerEvent === 'function') {
      alvo.dispatchEvent(new janelaPagina.PointerEvent('pointerup', { ...opcoes, pointerId: 1, isPrimary: true }));
    }
    alvo.dispatchEvent(new janelaPagina.MouseEvent('mouseup', opcoes));
    alvo.click();
  }

  function linhaMarcadaComoSelecionada(linha) {
    if (!linha) return false;
    if (linha.getAttribute('aria-selected') === 'true') return true;
    if (linha.getAttribute('data-selected') === 'true') return true;
    return (
      linha.classList.contains('active') ||
      Boolean(linha.querySelector('.slick-cell.active, .slick-cell.selected'))
    );
  }

  function acharLinhas() {
    let candidatas = [...document.querySelectorAll('td, [role="gridcell"]')]
      .filter((el) => visivel(el) && DATA_HORA.test(texto(el.innerText)));

    if (!candidatas.length) {
      candidatas = [...document.querySelectorAll('div, span')]
        .filter((el) => visivel(el) && DATA_HORA.test(texto(el.innerText)));
    }

    const unicas = [];
    const chaves = new Set();

    for (const elemento of candidatas) {
      const caixa = elemento.getBoundingClientRect();
      const data = texto(elemento.innerText);
      const chave = `${data}|${Math.round(caixa.left)}|${Math.round(caixa.top)}`;
      if (!chaves.has(chave)) {
        chaves.add(chave);
        const linha =
          elemento.closest('tr, [role="row"], .slick-row, .dx-data-row, .k-grid-row, .ui-grid-row') ||
          elemento.parentElement;
        unicas.push({ elemento, linha, data });
      }
    }

    return unicas.sort(
      (a, b) => a.elemento.getBoundingClientRect().top - b.elemento.getBoundingClientRect().top
    );
  }

  function informar(mensagem, tipo = 'normal') {
    if (!painel) return;
    painel.textContent = mensagem;
    painel.style.background = tipo === 'erro' ? '#9f1d1d' : (tipo === 'ok' ? '#1b5e3a' : '#173b59');
  }

  function atualizarBotoes() {
    if (!botaoCopiar || executando) return;
    const quantidade = acharLinhas().length;
    const cfg = configIA();
    botaoCopiar.textContent = `Copiar + TXT (${quantidade})`;
    botaoXls.textContent = `Baixar XLS (${quantidade})`;
    botaoXls.disabled = quantidade === 0;
    botaoIA.textContent = cfg.chave
      ? `Relatorio IA (${quantidade})`
      : `Pacote p/ IA (${quantidade})`;
    botaoIA.title = cfg.chave
      ? `Corrige as evolucoes e gera o relatorio com ${PROVEDORES[cfg.provedor].nome} (${cfg.modelo}); sai em TXT e na area de transferencia`
      : 'Sem chave de IA configurada (menu do Tampermonkey): gera prompt + evolucoes para colar numa IA de chat';
    botaoResumo.textContent = `Resumo IA (${Math.min(quantidade, Math.max(cfg.maxNotas, 15) || quantidade)})`;
    botaoResumo.title = 'Resume o caso para colar no topo da evolucao (historico neuro direto, doenca de base didatica, exames, HD) com as notas mais recentes';
    botaoCopiar.disabled = quantidade === 0;
    botaoIA.disabled = quantidade === 0;
    botaoResumo.disabled = quantidade === 0 || !cfg.chave;
    grupoBotoes.style.display = quantidade === 0 ? 'none' : 'inline-flex';
  }

  function extrairDadosDaLinha(linha) {
    const celulas = [...linha.querySelectorAll('td, [role="gridcell"]')];
    if (celulas.length) {
      const grade = linha.closest('table, [role="grid"]') || document;
      const cabecalhos = [...grade.querySelectorAll('th, [role="columnheader"]')]
        .filter(visivel)
        .map((el) => texto(el.innerText));

      return celulas
        .map((celula, indice) => ({
          campo: cabecalhos[indice] || `Coluna ${indice + 1}`,
          valor: texto(celula.innerText)
        }))
        .filter((item) => item.valor)
        .map((item) => `${item.campo}: ${item.valor}`);
    }

    const resumo = texto(linha.innerText);
    return resumo ? [`Dados da linha: ${resumo}`] : [];
  }

  function extrairConteudo() {
    const candidatos = [];

    for (const el of document.querySelectorAll(
      'textarea, .wrichedit-editor.cke_editable, [contenteditable="true"], ' +
      '.note-editable, .ql-editor, .ProseMirror'
    )) {
      if (!visivel(el) || el.closest('#tm-ia-evolucoes-painel')) continue;
      const conteudo = textoConteudo(el.value || el.innerText || el.textContent);
      if (conteudo) {
        const caixa = el.getBoundingClientRect();
        candidatos.push({ conteudo, area: caixa.width * caixa.height });
      }
    }

    for (const frame of document.querySelectorAll('iframe')) {
      if (!visivel(frame)) continue;
      try {
        const corpo = frame.contentDocument && frame.contentDocument.body;
        const conteudo = corpo ? textoConteudo(corpo.innerText || corpo.textContent) : '';
        if (conteudo) {
          const caixa = frame.getBoundingClientRect();
          candidatos.push({ conteudo, area: caixa.width * caixa.height });
        }
      } catch (_) {
        // Ignora somente frames de outro dominio.
      }
    }

    candidatos.sort((a, b) => b.area - a.area);
    return candidatos[0]?.conteudo || '';
  }

  async function esperarConteudoEstavel(limiteMs = 1800) {
    const inicio = Date.now();
    let anterior = '';
    let repeticoes = 0;

    while (Date.now() - inicio < limiteMs) {
      await esperar(100);
      const atual = extrairConteudo();
      if (atual && atual === anterior) repeticoes += 1;
      else repeticoes = 0;
      anterior = atual;
      if (atual && repeticoes >= 2) return atual;
    }

    return extrairConteudo();
  }

  async function selecionarLinha(item) {
    const jaEstavaSelecionada = linhaMarcadaComoSelecionada(item.linha);
    if (!jaEstavaSelecionada) {
      for (let tentativa = 0; tentativa < 2; tentativa += 1) {
        clicarLinha(item, tentativa === 1);
        const inicio = Date.now();

        while (Date.now() - inicio < 2500) {
          await esperar(50);
          if (linhaMarcadaComoSelecionada(item.linha)) break;
        }
        if (linhaMarcadaComoSelecionada(item.linha)) break;
      }
    }

    if (!linhaMarcadaComoSelecionada(item.linha)) {
      throw new Error(
        `O Tasy nao ativou a linha de ${item.data}. ` +
        'Clique em Cancelar se a nota estiver em modo de edicao e tente novamente.'
      );
    }

    if (!jaEstavaSelecionada) await esperar(450);
    const conteudo = await esperarConteudoEstavel(2200);
    if (!conteudo) {
      throw new Error(`O editor da evolucao de ${item.data} apareceu vazio.`);
    }
    return conteudo;
  }

  function capturarIdentificacaoVisivel() {
    const nomes = [
      'Atendimento', 'Prontuário', 'Sexo', 'Nascimento', 'Idade', 'Setor - Leito',
      'Entrada', 'PO', 'Dias de internação', 'Nome social/afetivo',
      'Peso (último valor)', 'Altura (cm)', 'SC', 'Cidade', 'Classificação', 'RH',
      'Precaução - Paciente'
    ];
    const resultado = [];

    for (const nome of nomes) {
      const rotulos = [...document.querySelectorAll('span, div, label, dt')]
        .filter((el) => visivel(el) && texto(el.innerText) === nome);
      let melhor = '';

      for (const rotulo of rotulos) {
        let pai = rotulo.parentElement;
        for (let nivel = 0; pai && nivel < 3; nivel += 1, pai = pai.parentElement) {
          const total = texto(pai.innerText);
          if (total.length > nome.length && total.length <= 180 && total.startsWith(nome)) {
            const valor = texto(total.slice(nome.length));
            if (valor && (!melhor || valor.length < melhor.length)) melhor = valor;
          }
        }
      }

      if (melhor) resultado.push(`${nome}: ${melhor}`);
    }

    return resultado;
  }

  // ------------------------------------------------------------------ coleta

  /** Percorre as linhas visiveis e devolve [{data, meta:[...], conteudo}]. */
  async function coletarEvolucoes() {
    const datas = [...new Set(acharLinhas().map((linha) => linha.data))];
    const evolucoes = [];
    for (let indice = 0; indice < datas.length; indice += 1) {
      if (cancelar) break;
      const item = acharLinhas().find((linha) => linha.data === datas[indice]);
      if (!item) throw new Error(`Linha nao encontrada: ${datas[indice]}`);

      informar(`Lendo ${indice + 1}/${datas.length}: ${datas[indice]}`);
      const conteudo = await selecionarLinha(item);
      if (!conteudo) {
        throw new Error(`O conteudo da evolucao de ${datas[indice]} nao foi localizado.`);
      }
      evolucoes.push({ data: datas[indice], meta: extrairDadosDaLinha(item.linha), conteudo });
    }
    return evolucoes;
  }

  /** TXT completo, igual ao do script antigo (com identificacao e metadados). */
  function montarTextoCompleto(evolucoes, identificacao) {
    const secoes = ['EVOLUCOES - EXPORTACAO LOCAL', `Gerado em: ${new Date().toLocaleString('pt-BR')}`];
    if (identificacao.length) secoes.push('', 'IDENTIFICACAO', ...identificacao);
    evolucoes.forEach((ev, i) => {
      secoes.push('', '='.repeat(78), `EVOLUCAO ${i + 1} DE ${evolucoes.length}`,
        `Data da nota clinica: ${ev.data}`, ...ev.meta, '', 'CONTEUDO', ev.conteudo);
    });
    return secoes.join('\r\n');
  }

  /** Nota do tipo "Evolução Médica" (pela coluna Tipo de nota clinica ou pela funcao Medico). */
  function evolucaoMedica(ev) {
    const meta = ev.meta.join(' | ');
    const tipo = meta.match(/Tipo de nota cl[ií]nica:\s*([^|]+)/i);
    if (tipo) return /m[eé]dic/i.test(tipo[1]);
    return /Fun[cç][aã]o:\s*M[eé]dic/i.test(meta);
  }

  /** Linhas de identificacao que os medicos escrevem DENTRO da nota
   *  ("#ID Fulano, DN 01/01/1960, pront 123") nao vao para a IA. */
  function semIdentificacaoNoTexto(conteudo) {
    return conteudo.split('\n')
      .filter((l) => !/^\s*#?\s*ID\b/i.test(l) && !/\bpront(u[aá]rio)?\.?\s*:?\s*\d{4,}/i.test(l))
      .join('\n');
  }

  /** So o que vai para a IA: data + conteudo. Sem identificacao, sem profissional. */
  function montarTextoParaIA(evolucoes) {
    const blocos = evolucoes.map((ev, i) => `### EVOLUÇÃO ${i + 1}, ${ev.data}\n${semIdentificacaoNoTexto(ev.conteudo)}`);
    let saida = blocos.join('\n\n');
    if (saida.length > LIMITE_CARACTERES_IA) {
      // mantem as mais recentes (a lista do Tasy vem da mais nova para a mais antiga)
      const mantidos = [];
      let total = 0;
      for (const bloco of blocos) {
        if (total + bloco.length > LIMITE_CARACTERES_IA) break;
        mantidos.push(bloco);
        total += bloco.length + 2;
      }
      saida = mantidos.join('\n\n');
      saida = `(Prontuário extenso: enviadas as ${mantidos.length} notas mais recentes de ${blocos.length}.)\n\n${saida}`;
    }
    return saida;
  }

  function baixarTexto(conteudo, prefixo) {
    const agora = new Date();
    const carimbo = [
      agora.getFullYear(),
      String(agora.getMonth() + 1).padStart(2, '0'),
      String(agora.getDate()).padStart(2, '0'),
      '-',
      String(agora.getHours()).padStart(2, '0'),
      String(agora.getMinutes()).padStart(2, '0'),
      String(agora.getSeconds()).padStart(2, '0')
    ].join('');
    const blob = new Blob(['\uFEFF', conteudo], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${prefixo}-${carimbo}.txt`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
  }

  function iniciarExecucao(botaoAtivo) {
    executando = true;
    cancelar = false;
    painel.style.display = 'block';
    botaoCopiar.disabled = true;
    botaoXls.disabled = true;
    botaoIA.disabled = true;
    botaoResumo.disabled = true;
    botaoAtivo.disabled = false;
    botaoAtivo.dataset.textoOriginal = botaoAtivo.textContent;
    botaoAtivo.textContent = 'Parar';
    botaoAtivo.dataset.corOriginal = botaoAtivo.style.background;
    botaoAtivo.style.background = '#b3261e';
  }

  function encerrarExecucao(botaoAtivo) {
    executando = false;
    cancelar = false;
    botaoAtivo.style.background = botaoAtivo.dataset.corOriginal || '';
    botaoCopiar.disabled = false;
    botaoXls.disabled = false;
    botaoIA.disabled = false;
    botaoResumo.disabled = false;
    atualizarBotoes();
    setTimeout(() => {
      if (!executando) painel.style.display = 'none';
    }, 8000);
  }

  // ------------------------------------------------------------------ botao 1: copiar + TXT

  async function copiarEExportarTexto() {
    if (executando) { cancelar = true; informar('Cancelando...'); return; }

    const quantidade = new Set(acharLinhas().map((l) => l.data)).size;
    if (!quantidade) { alert('Nenhuma evolucao visivel foi encontrada.'); return; }
    if (!confirm(`Copiar e baixar ${quantidade} evolucao(oes) em um TXT?`)) return;

    iniciarExecucao(botaoCopiar);
    try {
      const identificacao = capturarIdentificacaoVisivel();
      const evolucoes = await coletarEvolucoes();
      if (cancelar) { informar('Exportacao interrompida.'); return; }
      const resultado = montarTextoCompleto(evolucoes, identificacao);
      GM_setClipboard(resultado, 'text');
      baixarTexto(resultado, 'evolucoes');
      informar(`${evolucoes.length} evolucao(oes) copiadas e salvas em TXT.`, 'ok');
    } catch (erro) {
      console.error('[Copiar evolucoes]', erro);
      informar(`Erro: ${erro.message}`, 'erro');
      alert(`A leitura parou: ${erro.message}`);
    } finally {
      encerrarExecucao(botaoCopiar);
    }
  }

  // ------------------------------------------------------------------ botao 2: baixar XLS (nativo do Tasy, uma evolucao por arquivo)

  async function exportarTodasXls() {
    if (executando) { cancelar = true; informar('Cancelando...'); return; }

    const datas = [...new Set(acharLinhas().map((linha) => linha.data))];
    if (!datas.length) { alert('Nenhuma evolucao visivel foi encontrada.'); return; }
    if (!confirm(`Baixar ${datas.length} evolucao(oes) em XLS?`)) return;

    iniciarExecucao(botaoXls);
    try {
      for (let indice = 0; indice < datas.length; indice += 1) {
        if (cancelar) break;
        const linha = acharLinhas().find((item) => item.data === datas[indice]);
        if (!linha) throw new Error(`Linha nao encontrada: ${datas[indice]}`);

        informar(`Exportando ${indice + 1}/${datas.length}: ${datas[indice]}`);
        await selecionarLinha(linha);
        await esperar(PAUSA_SELECAO_MS);

        const relatorios = await esperarComando(['Relatórios', 'Relatorios']);
        clicar(relatorios);
        await esperar(PAUSA_MENU_MS);

        const exportar = await esperarComando('Exportar XLS');
        clicar(exportar);
        await esperar(PAUSA_DOWNLOAD_MS);
      }
      informar(cancelar ? 'Exportacao interrompida.' : 'Exportacao concluida.', cancelar ? 'normal' : 'ok');
      if (!cancelar) {
        alert('Exportacao concluida. Confira a pasta Downloads.\n\n' +
          'Se o Chrome pedir permissao para varios downloads, clique em Permitir.');
      }
    } catch (erro) {
      console.error('[Exportar XLS]', erro);
      informar(`Erro: ${erro.message}`, 'erro');
      alert(`A exportacao parou: ${erro.message}`);
    } finally {
      encerrarExecucao(botaoXls);
    }
  }

  // ------------------------------------------------------------------ botao 3: relatorio IA

  /** modo: 'relatorio' (INSS + correcao opcional) ou 'resumo' (resumo do caso). */
  async function gerarComIA(modo = 'relatorio') {
    if (executando) { cancelar = true; informar('Cancelando...'); return; }

    const quantidade = new Set(acharLinhas().map((l) => l.data)).size;
    if (!quantidade) { alert('Nenhuma evolucao visivel foi encontrada.'); return; }

    const resumo = modo === 'resumo';
    const botaoAtivo = resumo ? botaoResumo : botaoIA;
    const cfg = configIA();
    if (resumo) {
      if (!cfg.chave) { alert('Configure a chave da IA no botao ⚙ antes de resumir o caso.'); return; }
      if (!confirm(
        `Ler ${quantidade} evolucao(oes) e resumir o caso com ${PROVEDORES[cfg.provedor].nome} (${cfg.modelo})?\n\n` +
        'Sao enviados a IA somente data e texto das notas (sem identificacao).')) return;
    } else if (!cfg.chave) {
      if (!confirm(
        `Nenhuma chave de IA configurada neste navegador.\n\n` +
        `OK = gerar o PACOTE (prompt + ${quantidade} evolucao(oes)) em TXT e na area de transferencia, para colar em qualquer IA.\n` +
        `Cancelar = sair. Para configurar a chave: icone do Tampermonkey > este script > "Configurar IA...".`)) return;
    } else {
      if (!cfg.gerarRelatorio && !cfg.gerarCorrecao) {
        alert('As duas saidas estao desligadas. Ligue pelo menu "Escolher saidas".');
        return;
      }
      const oque = [cfg.gerarCorrecao && 'evolucoes corrigidas', cfg.gerarRelatorio && 'relatorio medico']
        .filter(Boolean).join(' + ');
      if (!confirm(
        `Ler ${quantidade} evolucao(oes)${cfg.soMedicas ? ' (so as medicas)' : ''} e gerar com ${PROVEDORES[cfg.provedor].nome} (${cfg.modelo}):\n${oque}.\n\n` +
        'Sao enviados a IA somente data e texto das notas (sem identificacao). Continuar?')) return;
    }

    iniciarExecucao(botaoAtivo);
    try {
      const identificacao = capturarIdentificacaoVisivel();
      const todas = await coletarEvolucoes();
      if (cancelar) { informar('Interrompido.'); return; }
      // o que vai para a IA: opcionalmente so as medicas e, por padrao, so as
      // 10 mais recentes (a grade do Tasy vem da mais nova para a mais antiga)
      let evolucoes = cfg.chave && cfg.soMedicas ? todas.filter(evolucaoMedica) : todas;
      if (!evolucoes.length) throw new Error('nenhuma nota do tipo "Evolução Médica" entre as visiveis');
      // resumo do caso aceita mais historia: ate 15 notas (pedido de 29/09/2026)
      const limite = resumo ? Math.max(cfg.maxNotas, 15) : cfg.maxNotas;
      if (cfg.chave && limite > 0) evolucoes = evolucoes.slice(0, limite);

      const textoIA = montarTextoParaIA(evolucoes);
      const carimbo = new Date().toLocaleString('pt-BR');
      const cabecalho = [
        'DOCUMENTO GERADO COM AUXILIO DE IA - RASCUNHO, REVISAR E EDITAR ANTES DE USAR',
        `Gerado em: ${carimbo}`,
        `Evolucoes lidas: ${todas.length}; enviadas a IA: ${evolucoes.length}` +
          (evolucoes.length < todas.length ? ' (as mais recentes; ajuste em ⚙ > 3)' : ''),
      ];
      if (identificacao.length) cabecalho.push('', 'IDENTIFICACAO (nao enviada a IA)', ...identificacao);

      // sem chave: pacote para colar numa IA de chat
      if (!cfg.chave) {
        const pacote = [
          'INSTRUÇÕES PARA A IA (cole este arquivo inteiro no chat):', '',
          PROMPT_RELATORIO, '',
          'Depois do relatório, devolva também as evoluções corrigidas conforme as regras abaixo:', '',
          PROMPT_CORRECAO, '',
          '='.repeat(78), 'EVOLUÇÕES', '', textoIA,
        ].join('\r\n');
        GM_setClipboard(pacote, 'text');
        baixarTexto(pacote, 'pacote-ia');
        informar('Pacote (prompt + evolucoes) copiado e salvo em TXT. Cole numa IA de chat.', 'ok');
        return;
      }

      informar(`Enviando ${evolucoes.length} evolucao(oes) a ${PROVEDORES[cfg.provedor].nome}... (15 a 60 s)`);
      const tarefas = [];
      if (resumo) {
        tarefas.push(chamarIA(cfg, PROMPT_RESUMO,
          `Evoluções neurológicas do prontuário, da mais recente para a mais antiga:\n\n${textoIA}`)
          .then((t) => ['resumo', limparSaida(t)]));
      }
      if (!resumo && cfg.gerarRelatorio) {
        tarefas.push(chamarIA(cfg, PROMPT_RELATORIO,
          `Evoluções neurológicas do prontuário, da mais recente para a mais antiga:\n\n${textoIA}`)
          .then((t) => ['relatorio', limparSaida(t)]));
      }
      if (!resumo && cfg.gerarCorrecao) {
        tarefas.push(chamarIA(cfg, PROMPT_CORRECAO, textoIA)
          .then((t) => ['correcao', limparSaida(t)]));
      }
      const resultados = await Promise.allSettled(tarefas);
      if (cancelar) { informar('Interrompido.'); return; }

      const saidas = {};
      const erros = [];
      for (const r of resultados) {
        if (r.status === 'fulfilled') saidas[r.value[0]] = r.value[1];
        else erros.push(r.reason?.message || String(r.reason));
      }
      if (!Object.keys(saidas).length) {
        throw new Error(erros.join(' | ') || 'a IA nao devolveu nada');
      }

      const secoes = [...cabecalho, `IA: ${PROVEDORES[cfg.provedor].nome}, modelo ${cfg.modelo}`];
      if (erros.length) secoes.push('', `AVISO: parte falhou: ${erros.join(' | ')}`);
      if (saidas.resumo) {
        secoes.push('', '='.repeat(78), 'RESUMO DO CASO (rascunho da IA)', '', saidas.resumo);
      }
      if (saidas.relatorio) {
        secoes.push('', '='.repeat(78), 'RELATORIO MEDICO (rascunho da IA)', '', saidas.relatorio);
      }
      // evolucoes corrigidas so entram no TXT se a saida estiver ligada (⚙ > 3);
      // as originais nao entram (pedido de 29/09/2026: "so o relatorio mesmo")
      if (saidas.correcao) {
        secoes.push('', '='.repeat(78), 'EVOLUCOES CORRIGIDAS (portugues; conteudo preservado)', '',
          saidas.correcao.replace(/\n/g, '\r\n'));
      }
      const resultado = secoes.join('\r\n');

      // area de transferencia: o texto principal (o que se cola no documento);
      // sem relatorio, vao as evolucoes corrigidas
      const principal = saidas.resumo || saidas.relatorio || saidas.correcao;
      GM_setClipboard(principal, 'text');
      baixarTexto(resultado, resumo ? 'resumo-ia' : 'relatorio-ia');
      const nome = resumo ? 'resumo do caso' : 'relatorio';
      informar(
        `Pronto: ${nome}${saidas.correcao ? ' + evolucoes corrigidas' : ''} em TXT; ` +
        `${nome} na area de transferencia.` +
        (erros.length ? ' (parte falhou, veja o TXT)' : ''), erros.length ? 'erro' : 'ok');
    } catch (erro) {
      console.error('[Relatorio IA]', erro);
      informar(`Erro: ${erro.message}`, 'erro');
      alert(`Nao foi possivel gerar: ${erro.message}`);
    } finally {
      encerrarExecucao(botaoAtivo);
    }
  }

  // ------------------------------------------------------------------ interface

  function criarBotao(id, cor) {
    const b = document.createElement('button');
    b.id = id;
    b.type = 'button';
    Object.assign(b.style, {
      position: 'static',
      padding: '5px 8px',
      border: '0',
      borderRadius: '4px',
      background: cor,
      color: '#fff',
      font: 'bold 12px Arial, sans-serif',
      cursor: 'pointer',
      whiteSpace: 'nowrap'
    });
    return b;
  }

  function instalarInterface() {
    if (document.getElementById('tm-ia-evolucoes-acoes')) return;

    grupoBotoes = document.createElement('span');
    grupoBotoes.id = 'tm-ia-evolucoes-acoes';
    Object.assign(grupoBotoes.style, {
      display: 'none',
      alignItems: 'center',
      gap: '5px',
      marginLeft: '6px',
      verticalAlign: 'middle'
    });

    painel = document.createElement('div');
    painel.id = 'tm-ia-evolucoes-painel';
    Object.assign(painel.style, {
      position: 'fixed',
      left: '50%',
      top: '105px',
      transform: 'translateX(-50%)',
      zIndex: '2147483647',
      display: 'none',
      maxWidth: '420px',
      padding: '9px 12px',
      borderRadius: '6px',
      background: '#173b59',
      color: '#fff',
      font: '13px Arial, sans-serif',
      boxShadow: '0 2px 10px rgba(0,0,0,.3)'
    });

    botaoCopiar = criarBotao('tm-ia-copiar-evolucoes', '#2155a5');
    botaoCopiar.addEventListener('click', copiarEExportarTexto);

    botaoXls = criarBotao('tm-ia-baixar-xls', '#087f5b');
    botaoXls.addEventListener('click', exportarTodasXls);

    botaoIA = criarBotao('tm-ia-relatorio', '#6a1b9a');
    botaoIA.addEventListener('click', () => gerarComIA('relatorio'));

    botaoResumo = criarBotao('tm-ia-resumo', '#ad1457');
    botaoResumo.addEventListener('click', () => gerarComIA('resumo'));

    const botaoConfig = criarBotao('tm-ia-config', '#555');
    botaoConfig.textContent = '⚙';
    botaoConfig.title = 'Configurar IA (chave, modelo, saidas)';
    botaoConfig.addEventListener('click', menuConfiguracao);

    grupoBotoes.append(botaoCopiar, botaoXls, botaoIA, botaoResumo, botaoConfig);
    document.body.append(painel, grupoBotoes);
    posicionarInterface();
    atualizarBotoes();
  }

  function posicionarInterface() {
    if (!grupoBotoes) return;

    const titulos = [...document.querySelectorAll('.panel-title')]
      .filter((el) => texto(el.innerText) === 'Notas clínicas');
    const painelNotas = titulos[0]?.closest('.wtitle');
    const barra = painelNotas?.querySelector('.handlebar-buttons');
    if (!barra) return;

    if (grupoBotoes.parentElement !== barra) {
      // depois do grupo do script antigo, se ele estiver ativo; senao depois de Relatórios
      const antigo = barra.querySelector('#tm-evolucoes-acoes');
      const relatorios = [...barra.querySelectorAll('button')]
        .find((el) => texto(el.innerText) === 'Relatórios');
      if (antigo) antigo.insertAdjacentElement('afterend', grupoBotoes);
      else if (relatorios) relatorios.insertAdjacentElement('afterend', grupoBotoes);
      else barra.appendChild(grupoBotoes);
    }
  }

  instalarInterface();
  setInterval(() => {
    posicionarInterface();
    atualizarBotoes();
  }, 1200);
})();
