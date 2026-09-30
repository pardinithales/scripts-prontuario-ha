// ==UserScript==
// @name         Tasy - Evolucoes + IA (correcao e relatorio)
// @namespace    local.thales.evolucoes.ia
// @version      3.0.2
// @description  Na tela de Notas clinicas do Tasy: um clique le as evolucoes medicas mais recentes e gera o relatorio medico (INSS) com IA (Claude, OpenAI ou Gemini), pronto para colar no Atestado. Tambem: resumo do caso, copiar evolucoes em TXT e exportar XLS.
// @homepageURL  https://github.com/pardinithales/scripts-prontuario-ha
// @downloadURL  https://raw.githubusercontent.com/pardinithales/scripts-prontuario-ha/main/tasy-evolucoes-ia.user.js
// @updateURL    https://raw.githubusercontent.com/pardinithales/scripts-prontuario-ha/main/tasy-evolucoes-ia.user.js
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
  (GM_setValue), nunca sai para outro lugar. Configurar pelo botao ⚙ que
  aparece ao lado dos outros botoes na tela de Notas clinicas.

  Instalar: com o Tampermonkey instalado, abrir o link do @downloadURL acima
  e clicar em Instalar. Atualizacoes chegam sozinhas pelo mesmo link.

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

  // Modelos padrao sao editaveis no botao ⚙. Teste de 28/09/2026
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
      // por padrao so notas de medico (coluna Tipo de nota / Funcao da grade),
      // para nao depender do filtro do Tasy; se a grade nao tiver a coluna,
      // vai tudo que estiver visivel
      soMedicas: GM_getValue('ia_so_medicas', true),
      // o texto sempre aparece na janela + area de transferencia; TXT e opcional
      baixarTxt: GM_getValue('ia_baixar_txt', false),
      // quantas notas (as mais recentes) vao para a IA; 0 = todas. 26 notas
      // levaram ~1 min em 29/09/2026; 10 basta para o relatorio
      maxNotas: Number(GM_getValue('ia_max_notas', 10)) || 0,
    };
  }

  // ------------------------------------------------------------------ janelas (modal)

  const ESTILO_BOTAO = 'padding:6px 12px;border:0;border-radius:4px;color:#fff;font:bold 13px Arial,sans-serif;cursor:pointer';
  const ESTILO_CAMPO = 'width:100%;box-sizing:border-box;padding:6px 8px;border:1px solid #bbb;border-radius:4px;font:13px Arial,sans-serif';

  /** Janela simples por cima do Tasy. Devolve {corpo, fechar}. Esc ou clique fora fecha. */
  function abrirJanela(titulo, largura = 560) {
    document.getElementById('tm-ia-janela')?.remove();
    const fundo = document.createElement('div');
    fundo.id = 'tm-ia-janela';
    fundo.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center';
    const caixa = document.createElement('div');
    caixa.style.cssText = `width:${largura}px;max-width:95vw;max-height:92vh;overflow:auto;background:#fff;color:#222;border-radius:8px;box-shadow:0 6px 30px rgba(0,0,0,.4);font:13px Arial,sans-serif`;
    const cabecalho = document.createElement('div');
    cabecalho.style.cssText = 'padding:12px 16px;background:#173b59;color:#fff;font:bold 15px Arial,sans-serif;border-radius:8px 8px 0 0;display:flex;justify-content:space-between;align-items:center';
    cabecalho.textContent = titulo;
    const x = document.createElement('button');
    x.type = 'button'; x.textContent = '✕'; x.title = 'Fechar (Esc)';
    x.style.cssText = 'background:none;border:0;color:#fff;font-size:16px;cursor:pointer';
    cabecalho.appendChild(x);
    const corpo = document.createElement('div');
    corpo.style.cssText = 'padding:14px 16px';
    caixa.append(cabecalho, corpo);
    fundo.appendChild(caixa);
    const fechar = () => { fundo.remove(); document.removeEventListener('keydown', tecla); };
    const tecla = (e) => { if (e.key === 'Escape') fechar(); };
    x.addEventListener('click', fechar);
    fundo.addEventListener('mousedown', (e) => { if (e.target === fundo) fechar(); });
    document.addEventListener('keydown', tecla);
    document.body.appendChild(fundo);
    return { corpo, fechar };
  }

  function botaoJanela(rotulo, cor, acao) {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = rotulo;
    b.style.cssText = `${ESTILO_BOTAO};background:${cor}`;
    b.addEventListener('click', acao);
    return b;
  }

  function campoJanela(rotulo, elemento, ajuda) {
    const bloco = document.createElement('label');
    bloco.style.cssText = 'display:block;margin:0 0 10px';
    const titulo = document.createElement('div');
    titulo.style.cssText = 'font-weight:bold;margin-bottom:3px';
    titulo.textContent = rotulo;
    bloco.append(titulo, elemento);
    if (ajuda) {
      const dica = document.createElement('div');
      dica.style.cssText = 'color:#666;font-size:12px;margin-top:2px';
      dica.textContent = ajuda;
      bloco.appendChild(dica);
    }
    return bloco;
  }

  function caixaMarcar(rotulo, marcado, ajuda) {
    const linha = document.createElement('label');
    linha.style.cssText = 'display:flex;gap:8px;align-items:flex-start;margin:0 0 8px;cursor:pointer';
    const cx = document.createElement('input');
    cx.type = 'checkbox'; cx.checked = !!marcado; cx.style.marginTop = '2px';
    const txt = document.createElement('span');
    txt.innerHTML = `<b>${rotulo}</b>` + (ajuda ? `<br><span style="color:#666;font-size:12px">${ajuda}</span>` : '');
    linha.append(cx, txt);
    return { linha, cx };
  }

  // ------------------------------------------------------------------ configuracao (botao ⚙)

  /** Uma janela so, com todos os ajustes; a chave continua so no Tampermonkey deste navegador. */
  function configurarIA() {
    const cfg = configIA();
    const { corpo, fechar } = abrirJanela('Configurar IA');

    const selProvedor = document.createElement('select');
    selProvedor.style.cssText = ESTILO_CAMPO;
    for (const [id, info] of Object.entries(PROVEDORES)) {
      const o = document.createElement('option');
      o.value = id; o.textContent = `${info.nome} (padrao: ${info.modeloPadrao})`;
      if (id === cfg.provedor) o.selected = true;
      selProvedor.appendChild(o);
    }
    const inChave = document.createElement('input');
    inChave.type = 'password'; inChave.style.cssText = ESTILO_CAMPO; inChave.autocomplete = 'off';
    inChave.placeholder = cfg.chave ? 'chave ja configurada; deixe em branco para manter' : 'cole aqui a chave da API';
    const inModelo = document.createElement('input');
    inModelo.type = 'text'; inModelo.style.cssText = ESTILO_CAMPO;
    inModelo.value = GM_getValue('ia_modelo', '') || '';
    inModelo.placeholder = `em branco = ${PROVEDORES[cfg.provedor].modeloPadrao}`;
    const inWorkspace = document.createElement('input');
    inWorkspace.type = 'text'; inWorkspace.style.cssText = ESTILO_CAMPO;
    inWorkspace.value = cfg.workspace; inWorkspace.placeholder = 'wrkspc_... (so se a chave for da organizacao)';
    const blocoWorkspace = campoJanela('Workspace da Anthropic (opcional)', inWorkspace,
      'Necessario so se aparecer o erro "not scoped to a workspace".');
    const inMax = document.createElement('input');
    inMax.type = 'number'; inMax.min = '0'; inMax.style.cssText = `${ESTILO_CAMPO};width:90px`;
    inMax.value = String(cfg.maxNotas);

    const cxRelatorio = caixaMarcar('Relatorio medico (INSS)', cfg.gerarRelatorio);
    const cxCorrecao = caixaMarcar('Evolucoes corrigidas (portugues; conteudo preservado)', cfg.gerarCorrecao, 'Dobra o tempo. Desligado por padrao.');
    const cxMedicas = caixaMarcar('So notas de medico', cfg.soMedicas,
      'Ignora enfermagem, farmacia etc. pela coluna Tipo/Funcao da grade, sem precisar do filtro do Tasy. Se a grade nao tiver essa coluna, vai tudo que estiver visivel.');
    const cxTxt = caixaMarcar('Baixar TXT automaticamente', cfg.baixarTxt, 'O texto sempre aparece na janela e vai para a area de transferencia; o TXT e opcional.');

    const atualizarProvedor = () => {
      const p = selProvedor.value;
      inModelo.placeholder = `em branco = ${PROVEDORES[p].modeloPadrao}`;
      blocoWorkspace.style.display = p === 'anthropic' ? 'block' : 'none';
    };
    selProvedor.addEventListener('change', atualizarProvedor);
    atualizarProvedor();

    const status = document.createElement('div');
    status.style.cssText = 'margin:8px 0;min-height:18px;color:#1b5e3a;font-weight:bold';

    const salvar = () => {
      const p = PROVEDORES[selProvedor.value] ? selProvedor.value : PROVEDOR_PADRAO;
      GM_setValue('ia_provedor', p);
      if (texto(inChave.value)) GM_setValue('ia_chave', texto(inChave.value));
      const modelo = texto(inModelo.value);
      GM_setValue('ia_modelo', modelo === PROVEDORES[p].modeloPadrao ? '' : modelo);
      GM_setValue('ia_workspace', texto(inWorkspace.value));
      GM_setValue('ia_relatorio', cxRelatorio.cx.checked);
      GM_setValue('ia_correcao', cxCorrecao.cx.checked);
      GM_setValue('ia_so_medicas', cxMedicas.cx.checked);
      GM_setValue('ia_baixar_txt', cxTxt.cx.checked);
      if (/^\d+$/.test(texto(inMax.value))) GM_setValue('ia_max_notas', Number(texto(inMax.value)));
      atualizarBotoes();
    };

    const acoes = document.createElement('div');
    acoes.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;margin-top:12px';
    acoes.append(
      botaoJanela('Salvar', '#1b5e3a', () => { salvar(); fechar(); }),
      botaoJanela('Salvar e testar chave', '#2155a5', async () => {
        salvar();
        status.style.color = '#173b59'; status.textContent = 'Testando...';
        try {
          const cfgNova = configIA();
          if (!cfgNova.chave) throw new Error('nenhuma chave informada');
          const resposta = await chamarIA(cfgNova, 'Responda apenas: ok', 'teste', { rapido: true });
          status.style.color = '#1b5e3a';
          status.textContent = `Chave funcionando (${PROVEDORES[cfgNova.provedor].nome}, ${cfgNova.modelo}): ${texto(resposta).slice(0, 30)}`;
          inChave.value = ''; inChave.placeholder = 'chave ja configurada; deixe em branco para manter';
        } catch (erro) {
          status.style.color = '#9f1d1d'; status.textContent = `Falhou: ${erro.message}`;
        }
      }),
      botaoJanela('Apagar chave', '#9f1d1d', () => {
        GM_setValue('ia_chave', '');
        inChave.value = ''; inChave.placeholder = 'cole aqui a chave da API';
        status.style.color = '#9f1d1d'; status.textContent = 'Chave apagada deste navegador.';
        atualizarBotoes();
      }),
      botaoJanela('Cancelar', '#777', fechar),
    );

    const aviso = document.createElement('div');
    aviso.style.cssText = 'background:#f3f6fa;border-left:3px solid #173b59;padding:8px 10px;margin-bottom:12px;color:#333';
    aviso.textContent = 'A chave fica guardada so no Tampermonkey deste navegador. A IA recebe apenas data e texto das notas; identificacao do paciente e nome do profissional nao sao enviados.';

    const secao = (t) => { const d = document.createElement('div'); d.style.cssText = 'font-weight:bold;color:#173b59;margin:14px 0 8px;border-bottom:1px solid #ddd'; d.textContent = t; return d; };

    corpo.append(
      aviso,
      campoJanela('Provedor de IA', selProvedor),
      campoJanela('Chave da API', inChave, 'Anthropic: criar a chave dentro de um workspace (Console > API keys).'),
      campoJanela('Modelo', inModelo),
      blocoWorkspace,
      secao('O que gerar no botao Relatorio IA'),
      cxRelatorio.linha, cxCorrecao.linha,
      secao('Quais notas vao para a IA'),
      cxMedicas.linha,
      campoJanela('Quantas notas (as mais recentes); 0 = todas', inMax, '10 basta para o relatorio; o resumo do caso usa ao menos 15.'),
      secao('Saida'),
      cxTxt.linha,
      status, acoes,
    );
  }

  GM_registerMenuCommand('Configurar IA (chave, modelo, saidas)...', configurarIA);

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
    'ROTEIRO OBRIGATÓRIO DO CONTEÚDO (em parágrafos corridos, sem títulos, sem listas), cada ponto explícito quando os dados o sustentarem: (a) DÉFICITS: cada déficit neurológico presente no último exame, nomeado e graduado, com a data da avaliação. (b) INCAPACIDADES: o que o paciente NÃO consegue fazer por causa desses déficits, em atividades concretas, com frequência e desde quando, e a repercussão laboral quando descrita. (c) EPILEPSIA, quando houver: tipo de crise, frequência atual e anterior, data da última crise, aura ou perda de consciência, controle parcial ou refratário, fármacos que já falharam, restrições decorrentes (dirigir, altura, máquinas, fogo, turnos noturnos, ficar sozinho). (d) RISCOS: queda, crise no trabalho, acidente, piora com esforço ou privação de sono, sonolência pela medicação. (e) MEDICAÇÕES ATUAIS: cada fármaco em uso pela nota mais recente, no formato "Nome dose formulação manhã-tarde-noite" (ex.: Levetiracetam 250mg 1-0-1; Lamotrigina 100mg 1-0-1); efeitos adversos documentados. (f) PROGNÓSTICO E SEGUIMENTO: caráter crônico ou progressivo, perspectiva de melhora documentada e intervalo de retorno. Ponto sem dado no prontuário é simplesmente omitido, nunca preenchido com suposição nem com "não documentado".',
    '',
    'REGRAS FINAIS (prevalecem sobre qualquer instrução anterior): (1) As evoluções recebidas são a ÚNICA fonte da clínica; não invente diagnóstico, dose, data ou exame. (2) NUNCA cite nome de paciente, de familiar ou de profissional no texto; a identificação sai no cabeçalho do documento. (3) Encerramento: no máximo "Mantém seguimento neurológico com retorno programado, sem alta até o momento." (4) Termine com a linha "CID-10: código, descrição curta" (1 a 3 CIDs, um por linha). (5) Devolva só o relatório, sem título, sem comentários, sem markdown. (6) O que não está nas evoluções NÃO EXISTE para o relatório: nunca escreva "não há", "não consta", "sem registro", "não descrito", "não documentado", "aguardado", nem comente o que faltou; simplesmente não escreva sobre aquilo.',
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
    'Você recebe evoluções clínicas de um prontuário, da mais recente para a mais antiga. Escreva o resumo do caso para ficar no topo da próxima evolução de neurologia, do jeito que um neurologista escreve para si mesmo. Use só o que está nas evoluções e só o que é seguro (mais de 90% de certeza); na dúvida, omita. Não invente, não complete lacunas.',
    'REGRA CENTRAL: o que não está nas evoluções não existe para o resumo. Nunca escreva frases de ausência ou de espera ("não há", "não consta", "sem registro", "não descrito", "não há relato", "laudo aguardado", "não considerado"). Nunca comente o material ("o contexto vem de outras equipes", "a indicação não está descrita"). Nunca aconselhe nem recomende ("vigiar", "considerar", "atenção para", "sugere-se"). Só fatos datados e achados objetivos.',
    'Formato: seções curtas, cada uma iniciada por uma linha "# Título" (sem outro markdown). Primeira linha é a área do caso (ex.: "# NEURO-ONCOLOGIA", "# CEFALEIA", "# EPILEPSIA"). Depois, nesta ordem, SÓ as seções que tiverem conteúdo; seção sem conteúdo é omitida inteira, inclusive o título:',
    '# Histórico: a parte neurológica, bem direta, em ordem cronológica com datas (mês/ano), doses e resposta: o que falhou, o que foi intolerado, o que funcionou, procedimentos e o estado atual. Siglas habituais da neurologia, frases curtas, sem explicar o óbvio. Comorbidades relevantes para a neurologia (psiquiátricas, vasculares) em uma linha.',
    '# Resumo oncológico (ou hematológico, reumatológico, endócrino etc., quando houver doença de base de outra área): aqui seja didático, porque não é a área do leitor. Diga o tipo de tumor ou doença, estadiamento e marcadores com o significado prático em poucas palavras, tratamentos realizados com datas, situação atual (remissão, recidiva, em tratamento) e o que os exames mostram. Explique siglas e termos da outra área na primeira vez. Só o que está registrado; nada de "não há registro de quimioterapia".',
    '# Medicações: as em uso pela nota mais recente, uma por linha, no formato "Nome dose formulação manhã-tarde-noite" (ex.: "Levetiracetam 250mg 1-0-1", "Olanzapina 10mg 0-0-1", "Clonazepam 2mg gotas 0-0-1"). Se a dose ou a posologia não estiver registrada, escreva SÓ o nome ("Olanzapina"); nunca "dose não informada", "posologia não descrita" ou parecido. Sem sinais vitais, sem dieta, sem dados de enfermagem.',
    '# Exames relevantes: só neuroimagem, LCR, EEG, ENMG, anatomopatológico e laboratório alterados ou que definem conduta, com data e resultado. Exame sem resultado não entra. Nunca sinais vitais, saturação, peso, balanço hídrico.',
    '# HD: por último, e SOMENTE hipóteses neurológicas com base explícita nas evoluções (queixa, sinal, exame ou diagnóstico neurológico registrado). No máximo 3, uma por linha iniciada por hífen, cada uma com no máximo uma frase de justificativa cruzando clínica e exame. Diagnóstico de outra área, protocolo de exame sem queixa, comorbidade psiquiátrica isolada ou dado de enfermagem NÃO são hipótese. Se não houver hipótese neurológica, omita a seção # HD inteira.',
    'Estilo das linhas: fatos datados como itens iniciados por hífen e data ("- 04/08/2023: ressecção da lesão + linfonodo sentinela. AP: Breslow 5,0 mm, Clark V, ulcerado."); comorbidades numa linha "AP/AF:" dentro do Histórico; um exame relevante pode ser a própria linha de seção ("# RM encéfalo 09/2026: coleção subdural crônica frontoparietal E 1,3 cm"); na HD, use "-->" para a relação causal ("- Epilepsia focal estrutural --> sec. a subdural crônico"). Modelo fictício completo, para calibrar o tamanho: "# NEURO-ONCOLOGIA\n\nInternado por complicação de cirurgia pélvica (08/2026)\n\nAP/AF:\n- esquizofrenia, uso crônico de clonazepam e olanzapina\n\n# Resumo oncológico\nMelanoma acral plantar D, pT4b pN1a M0, EC IIIC. Significado: tumor espesso e ulcerado, 1 linfonodo com micrometástase, sem metástase à distância conhecida.\n- 08/2022: lesão plantar.\n- 04/08/2023: ressecção + linfonodo sentinela. AP: Breslow 5,0 mm, Clark V, 4 mitoses/mm², ulcerado; sentinela 1/3.\n- 28/08/2026: linfadenectomia pélvica D. AP em andamento.\n\n# Medicações\nOlanzapina 10mg 0-0-1\nClonazepam\n\n# RM encéfalo 29/09/2026: coleção subdural crônica frontoparietal E 1,3 cm\n\n# HD\n- Epilepsia focal estrutural --> sec. a subdural crônico".',
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
      : 'Sem chave de IA configurada (botao ⚙): gera prompt + evolucoes para colar numa IA de chat';
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
  async function coletarEvolucoes(linhasEscolhidas) {
    const datas = [...new Set((linhasEscolhidas || acharLinhas()).map((linha) => linha.data))];
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

    const visiveis = acharLinhas();
    if (!visiveis.length) { alert('Nenhuma evolucao visivel foi encontrada.'); return; }

    const resumo = modo === 'resumo';
    const botaoAtivo = resumo ? botaoResumo : botaoIA;
    const cfg = configIA();

    // Quais linhas ler: filtra ANTES de clicar (pela coluna Tipo de nota /
    // Funcao da grade) e corta nas N mais recentes (a grade vem da mais nova
    // para a mais antiga). Assim nao depende do filtro do Tasy e nao perde
    // tempo abrindo nota que nao vai para a IA.
    let linhasAlvo = visiveis;
    let avisoFiltro = '';
    if (cfg.chave && cfg.soMedicas) {
      const medicas = visiveis.filter((l) => evolucaoMedica({ meta: extrairDadosDaLinha(l.linha) }));
      if (medicas.length) linhasAlvo = medicas;
      else avisoFiltro = 'A grade nao mostra a coluna Tipo de nota/Funcao: foram lidas todas as notas visiveis. Para restringir, use o filtro do Tasy (notas do usuario) antes de clicar.';
    }
    const limite = resumo ? Math.max(cfg.maxNotas, 15) : cfg.maxNotas;
    if (cfg.chave && limite > 0) linhasAlvo = linhasAlvo.slice(0, limite);
    const quantidade = new Set(linhasAlvo.map((l) => l.data)).size;
    if (resumo) {
      if (!cfg.chave) { alert('Configure a chave da IA no botao ⚙ antes de resumir o caso.'); return; }
      if (!confirm(
        `Ler ${quantidade} evolucao(oes) e resumir o caso com ${PROVEDORES[cfg.provedor].nome} (${cfg.modelo})?\n\n` +
        'Sao enviados a IA somente data e texto das notas (sem identificacao).')) return;
    } else if (!cfg.chave) {
      if (!confirm(
        `Nenhuma chave de IA configurada neste navegador.\n\n` +
        `OK = gerar o PACOTE (prompt + ${quantidade} evolucao(oes)) em TXT e na area de transferencia, para colar em qualquer IA.\n` +
        `Cancelar = sair. Para configurar a chave: botao ⚙ ao lado deste.`)) return;
    } else {
      if (!cfg.gerarRelatorio && !cfg.gerarCorrecao) {
        alert('As duas saidas estao desligadas. Ligue pelo menu "Escolher saidas".');
        return;
      }
      const oque = [cfg.gerarCorrecao && 'evolucoes corrigidas', cfg.gerarRelatorio && 'relatorio medico']
        .filter(Boolean).join(' + ');
      const filtro = linhasAlvo.length < visiveis.length
        ? ` (${cfg.soMedicas && !avisoFiltro ? 'so as de medico, ' : ''}as ${quantidade} mais recentes de ${visiveis.length} visiveis)` : '';
      if (!confirm(
        `Ler ${quantidade} evolucao(oes)${filtro} e gerar com ${PROVEDORES[cfg.provedor].nome} (${cfg.modelo}):\n${oque}.\n\n` +
        'Sao enviados a IA somente data e texto das notas (sem identificacao). Continuar?')) return;
    }

    iniciarExecucao(botaoAtivo);
    try {
      const identificacao = capturarIdentificacaoVisivel();
      const todas = await coletarEvolucoes(cfg.chave ? linhasAlvo : visiveis);
      if (cancelar) { informar('Interrompido.'); return; }
      const evolucoes = todas;

      const textoIA = montarTextoParaIA(evolucoes);
      const carimbo = new Date().toLocaleString('pt-BR');
      const cabecalho = [
        'DOCUMENTO GERADO COM AUXILIO DE IA - RASCUNHO, REVISAR E EDITAR ANTES DE USAR',
        `Gerado em: ${carimbo}`,
        `Evolucoes visiveis na grade: ${visiveis.length}; lidas e enviadas a IA: ${evolucoes.length}` +
          (evolucoes.length < visiveis.length ? ' (as mais recentes; quantidade e filtro em ⚙)' : ''),
      ];
      if (avisoFiltro) cabecalho.push(`AVISO: ${avisoFiltro}`);
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
      // evolucoes corrigidas so entram no TXT se a saida estiver ligada (⚙);
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
      const prefixo = resumo ? 'resumo-ia' : 'relatorio-ia';
      if (cfg.baixarTxt) baixarTexto(resultado, prefixo);
      const nome = resumo ? 'resumo do caso' : 'relatorio';
      informar(`Pronto: ${nome} copiado.` + (erros.length ? ' (parte falhou, veja a janela)' : ''), erros.length ? 'erro' : 'ok');
      mostrarResultado(resumo ? 'Resumo do caso (rascunho da IA)' : 'Relatorio medico (rascunho da IA)',
        principal, resultado, prefixo, resumo, [avisoFiltro, ...erros.map((e) => `Parte falhou: ${e}`)].filter(Boolean));
    } catch (erro) {
      console.error('[Relatorio IA]', erro);
      informar(`Erro: ${erro.message}`, 'erro');
      alert(`Nao foi possivel gerar: ${erro.message}`);
    } finally {
      encerrarExecucao(botaoAtivo);
    }
  }

  // ------------------------------------------------------------------ janela de resultado

  /** O texto gerado numa janela, ja copiado, com o passo seguinte escrito. */
  function mostrarResultado(titulo, principal, completo, prefixo, resumo, avisos) {
    const { corpo, fechar } = abrirJanela(titulo, 760);

    const passos = document.createElement('div');
    passos.style.cssText = 'background:#e8f5ee;border-left:4px solid #1b5e3a;padding:10px 12px;margin-bottom:10px;line-height:1.5';
    passos.innerHTML = resumo
      ? '<b>Ja esta copiado.</b> Abra a evolucao de hoje, cole no topo (Ctrl+V) e revise antes de salvar.'
      : '<b>Ja esta copiado.</b> Agora: <b>1)</b> clique no nome do paciente (canto superior direito) ' +
        '&rarr; <b>Atestado</b>; <b>2)</b> Ctrl+V; <b>3)</b> revise, corrija e assine. ' +
        'E um rascunho: confira cada dado antes de entregar.';

    const area = document.createElement('textarea');
    area.readOnly = true;
    area.value = principal;
    area.style.cssText = 'width:100%;box-sizing:border-box;height:52vh;padding:10px;border:1px solid #bbb;border-radius:4px;font:13px/1.45 Consolas,monospace;resize:vertical';

    const acoes = document.createElement('div');
    acoes.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;margin-top:10px;align-items:center';
    const info = document.createElement('span');
    info.style.cssText = 'color:#1b5e3a;font-weight:bold;margin-left:auto';
    acoes.append(
      botaoJanela('Copiar de novo', '#2155a5', () => {
        GM_setClipboard(area.value, 'text');
        info.textContent = 'Copiado.'; setTimeout(() => { info.textContent = ''; }, 2500);
      }),
      botaoJanela('Baixar TXT', '#555', () => baixarTexto(completo, prefixo)),
      botaoJanela('Fechar', '#777', fechar),
      info,
    );

    corpo.appendChild(passos);
    for (const aviso of avisos || []) {
      const a = document.createElement('div');
      a.style.cssText = 'background:#fff4e5;border-left:4px solid #b26a00;padding:8px 12px;margin-bottom:10px';
      a.textContent = aviso;
      corpo.appendChild(a);
    }
    corpo.append(area, acoes);
    area.focus(); area.select();
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
    botaoConfig.title = 'Configurar IA (chave, modelo, quais notas, saidas)';
    botaoConfig.addEventListener('click', configurarIA);

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
