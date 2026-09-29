# scripts-prontuario-ha

Userscripts (Tampermonkey) para o prontuário Tasy do Hospital de Amor. A função é
otimizar o trabalho com as evoluções: copiar todas de uma vez e, com IA, gerar
relatório médico e resumo do caso a partir delas, sem sair da tela de Notas clínicas.

`tasy-evolucoes-ia.user.js` é o script atual. Ele adiciona botões ao lado de
**Relatórios** em Prontuário > Evolução > Notas clínicas:

- **Copiar + TXT** – lê as evoluções visíveis, copia e baixa um TXT com data e conteúdo.
- **Baixar XLS** – aciona o Exportar XLS nativo em cada nota.
- **Relatorio IA** – manda as 10 notas mais recentes à IA e devolve relatório médico
  (fins previdenciários) em TXT e na área de transferência.
- **Resumo IA** – até 15 notas; sumário do caso em duas partes (raciocínio das 3
  principais hipóteses e resumo curto para colar na evolução).
- **⚙** – provedor (Claude, OpenAI ou Gemini), chave, modelo, saídas.

A chave da API fica só no Tampermonkey do navegador (`GM_setValue`); não há servidor
no meio. À IA vão apenas data e texto das notas: identificação do paciente, profissional
e linhas `#ID` dentro da nota são removidas antes do envio. Padrão testado:
`claude-sonnet-5-5`.

Instalação: Tampermonkey > novo script > colar o arquivo > salvar. Depois, na tela do
Tasy, ⚙ > 1 para colocar a chave e ⚙ > 2 para testar. O script roda só em
`tasy.hospitaldeamor.com.br`; para outro Tasy, ajustar o `@match`.

`exportar-evolucoes-tampermonkey.user.js` é a versão anterior (só copiar/XLS),
mantida como referência. Não ativar os dois ao mesmo tempo.

O TXT gerado contém dados clínicos: tratar como prontuário. Nenhum dado de paciente
entra neste repositório.
