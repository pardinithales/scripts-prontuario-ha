// ==UserScript==
// @name         Tasy - Exportar todas as evolucoes em XLS
// @namespace    local.thales.evolucoes
// @version      1.3.0
// @description  Exporta XLS ou copia e baixa em TXT as evolucoes visiveis em Notas clinicas.
// @match        https://tasy.hospitaldeamor.com.br/*
// @grant        GM_setClipboard
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const DATA_HORA = /^\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}:\d{2}$/;

  // Ajuste estes valores apenas se o sistema ou a rede estiverem lentos.
  const PAUSA_SELECAO_MS = 300;
  const PAUSA_MENU_MS = 100;
  const PAUSA_DOWNLOAD_MS = 700;

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

  let executando = false;
  let cancelar = false;
  let botao;
  let botaoTexto;
  let grupoBotoes;
  let painel;

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

  function clicar(elemento) {
    elemento.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const JanelaMouseEvent = elemento.ownerDocument.defaultView.MouseEvent;
    elemento.dispatchEvent(new JanelaMouseEvent('mousedown', { bubbles: true }));
    elemento.dispatchEvent(new JanelaMouseEvent('mouseup', { bubbles: true }));
    elemento.click();
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
      alvo.dispatchEvent(
        new janelaPagina.PointerEvent('pointerdown', { ...opcoes, pointerId: 1, isPrimary: true })
      );
    }
    alvo.dispatchEvent(new janelaPagina.MouseEvent('mousedown', opcoes));
    if (typeof janelaPagina.PointerEvent === 'function') {
      alvo.dispatchEvent(
        new janelaPagina.PointerEvent('pointerup', { ...opcoes, pointerId: 1, isPrimary: true })
      );
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

  function acharComando(rotulos) {
    const opcoes = Array.isArray(rotulos) ? rotulos : [rotulos];
    const seletores = [
      'button',
      'a',
      'li',
      '[role="button"]',
      '[role="menuitem"]',
      'span',
      'div'
    ].join(',');

    return [...document.querySelectorAll(seletores)]
      .filter((el) => visivel(el) && opcoes.includes(texto(el.innerText)))
      .sort((a, b) => {
        const caixaA = a.getBoundingClientRect();
        const caixaB = b.getBoundingClientRect();
        return caixaA.width * caixaA.height - caixaB.width * caixaB.height;
      })[0];
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
          elemento.closest(
            'tr, [role="row"], .slick-row, .dx-data-row, .k-grid-row, .ui-grid-row'
          ) ||
          elemento.parentElement;
        unicas.push({ elemento, linha, data });
      }
    }

    return unicas.sort(
      (a, b) => a.elemento.getBoundingClientRect().top - b.elemento.getBoundingClientRect().top
    );
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

  function informar(mensagem, tipo = 'normal') {
    if (!painel) return;
    painel.textContent = mensagem;
    painel.style.background = tipo === 'erro' ? '#9f1d1d' : '#173b59';
  }

  function atualizarBotao() {
    if (!botao || executando) return;
    const quantidade = acharLinhas().length;
    botao.textContent = `Baixar XLS (${quantidade})`;
    botaoTexto.textContent = `Copiar + TXT (${quantidade})`;
    botao.disabled = quantidade === 0;
    botaoTexto.disabled = quantidade === 0;
    grupoBotoes.style.display = quantidade === 0 ? 'none' : 'inline-flex';
    botao.style.display = quantidade === 0 ? 'none' : 'inline-block';
    botaoTexto.style.display = quantidade === 0 ? 'none' : 'inline-block';
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
      if (!visivel(el) || el.closest('#tm-exportar-evolucoes-painel')) continue;
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

  function baixarTexto(conteudo) {
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
    link.download = `evolucoes-${carimbo}.txt`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
  }

  async function copiarEExportarTexto() {
    if (executando) {
      cancelar = true;
      informar('Cancelando...');
      return;
    }

    const datas = [...new Set(acharLinhas().map((linha) => linha.data))];
    if (!datas.length) {
      alert('Nenhuma evolucao visivel foi encontrada.');
      return;
    }
    if (!confirm(`Copiar e baixar ${datas.length} evolucao(oes) em um TXT?`)) return;

    executando = true;
    cancelar = false;
    botao.disabled = true;
    botaoTexto.textContent = 'Parar';
    botaoTexto.style.background = '#b3261e';

    try {
      const secoes = [];
      const identificacao = capturarIdentificacaoVisivel();
      secoes.push('EVOLUCOES - EXPORTACAO LOCAL');
      secoes.push(`Gerado em: ${new Date().toLocaleString('pt-BR')}`);
      if (identificacao.length) secoes.push('', 'IDENTIFICACAO', ...identificacao);

      for (let indice = 0; indice < datas.length; indice += 1) {
        if (cancelar) break;
        const item = acharLinhas().find((linha) => linha.data === datas[indice]);
        if (!item) throw new Error(`Linha nao encontrada: ${datas[indice]}`);

        informar(`Lendo ${indice + 1}/${datas.length}: ${datas[indice]}`);
        const conteudo = await selecionarLinha(item);
        if (!conteudo) {
          throw new Error(`O conteudo da evolucao de ${datas[indice]} nao foi localizado.`);
        }

        secoes.push(
          '',
          '='.repeat(78),
          `EVOLUCAO ${indice + 1} DE ${datas.length}`,
          `Data da nota clinica: ${datas[indice]}`,
          ...extrairDadosDaLinha(item.linha),
          '',
          'CONTEUDO',
          conteudo
        );
      }

      if (cancelar) {
        informar('Exportacao interrompida.');
        return;
      }

      const resultado = secoes.join('\r\n');
      GM_setClipboard(resultado, 'text');
      baixarTexto(resultado);
      informar(`${datas.length} evolucao(oes) copiadas e salvas em TXT.`);
      alert(
        `${datas.length} evolucao(oes) copiadas para a area de transferencia ` +
        'e baixadas em um unico arquivo TXT.'
      );
    } catch (erro) {
      console.error('[Copiar evolucoes]', erro);
      informar(`Erro: ${erro.message}`, 'erro');
      alert(`A leitura parou: ${erro.message}`);
    } finally {
      executando = false;
      cancelar = false;
      botao.disabled = false;
      botaoTexto.style.background = '#2155a5';
      atualizarBotao();
      setTimeout(() => {
        if (!executando) painel.style.display = 'none';
      }, 5000);
    }
  }

  async function exportarTodas() {
    if (executando) {
      cancelar = true;
      informar('Cancelando...');
      return;
    }

    const datas = [...new Set(acharLinhas().map((linha) => linha.data))];
    if (!datas.length) {
      alert('Nenhuma evolucao visivel foi encontrada.');
      return;
    }

    if (!confirm(`Baixar ${datas.length} evolucao(oes) em XLS?`)) return;

    executando = true;
    cancelar = false;
    botao.textContent = 'Parar';
    botao.style.background = '#b3261e';
    botaoTexto.disabled = true;

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

      informar(cancelar ? 'Exportacao interrompida.' : 'Exportacao concluida.');
      if (!cancelar) {
        alert(
          'Exportacao concluida. Confira a pasta Downloads.\n\n' +
          'Se o Chrome pedir permissao para varios downloads, clique em Permitir.'
        );
      }
    } catch (erro) {
      console.error('[Exportar evolucoes]', erro);
      informar(`Erro: ${erro.message}`, 'erro');
      alert(`A exportacao parou: ${erro.message}`);
    } finally {
      executando = false;
      cancelar = false;
      botao.style.background = '#087f5b';
      botaoTexto.disabled = false;
      atualizarBotao();
      setTimeout(() => {
        if (!executando) painel.style.display = 'none';
      }, 5000);
    }
  }

  function instalarInterface() {
    if (document.getElementById('tm-exportar-evolucoes')) return;

    grupoBotoes = document.createElement('span');
    grupoBotoes.id = 'tm-evolucoes-acoes';
    Object.assign(grupoBotoes.style, {
      display: 'none',
      alignItems: 'center',
      gap: '5px',
      marginLeft: '6px',
      verticalAlign: 'middle'
    });

    painel = document.createElement('div');
    painel.id = 'tm-exportar-evolucoes-painel';
    Object.assign(painel.style, {
      position: 'fixed',
      left: '50%',
      top: '105px',
      transform: 'translateX(-50%)',
      zIndex: '2147483647',
      display: 'none',
      maxWidth: '390px',
      padding: '9px 12px',
      borderRadius: '6px',
      background: '#173b59',
      color: '#fff',
      font: '13px Arial, sans-serif',
      boxShadow: '0 2px 10px rgba(0,0,0,.3)'
    });

    botao = document.createElement('button');
    botao.id = 'tm-exportar-evolucoes';
    botao.type = 'button';
    Object.assign(botao.style, {
      position: 'static',
      padding: '5px 8px',
      border: '0',
      borderRadius: '4px',
      background: '#087f5b',
      color: '#fff',
      font: 'bold 12px Arial, sans-serif',
      cursor: 'pointer',
      whiteSpace: 'nowrap'
    });
    botao.addEventListener('click', () => {
      painel.style.display = 'block';
      exportarTodas();
    });

    botaoTexto = document.createElement('button');
    botaoTexto.id = 'tm-copiar-evolucoes';
    botaoTexto.type = 'button';
    Object.assign(botaoTexto.style, {
      position: 'static',
      padding: '5px 8px',
      border: '0',
      borderRadius: '4px',
      background: '#2155a5',
      color: '#fff',
      font: 'bold 12px Arial, sans-serif',
      cursor: 'pointer',
      whiteSpace: 'nowrap'
    });
    botaoTexto.addEventListener('click', () => {
      painel.style.display = 'block';
      copiarEExportarTexto();
    });

    grupoBotoes.append(botaoTexto, botao);
    document.body.append(painel, grupoBotoes);
    posicionarInterface();
    atualizarBotao();
  }

  function posicionarInterface() {
    if (!grupoBotoes) return;

    const titulos = [...document.querySelectorAll('.panel-title')]
      .filter((el) => texto(el.innerText) === 'Notas clínicas');
    const painelNotas = titulos[0]?.closest('.wtitle');
    const barra = painelNotas?.querySelector('.handlebar-buttons');
    if (!barra) return;

    if (grupoBotoes.parentElement !== barra) {
      const relatorios = [...barra.querySelectorAll('button')]
        .find((el) => texto(el.innerText) === 'Relatórios');
      if (relatorios) relatorios.insertAdjacentElement('afterend', grupoBotoes);
      else barra.appendChild(grupoBotoes);
    }
  }

  instalarInterface();
  setInterval(() => {
    posicionarInterface();
    atualizarBotao();
  }, 1200);
})();
