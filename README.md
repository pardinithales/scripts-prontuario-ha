# scripts-prontuario-ha

Userscripts (Tampermonkey) para o prontuário Tasy do Hospital de Amor. A função é
otimizar o trabalho com as evoluções: copiar todas de uma vez e, com IA, gerar o
relatório médico (INSS) e o resumo do caso a partir delas, sem sair da tela de
Notas clínicas.

## Instalar (uma vez, 3 passos)

1. Instale a extensão **Tampermonkey** no Chrome ou Edge
   (https://www.tampermonkey.net).
2. Abra este link e clique em **Instalar**:
   https://raw.githubusercontent.com/pardinithales/scripts-prontuario-ha/main/tasy-evolucoes-ia.user.js
3. No Tasy, em Prontuário > Evolução > **Notas clínicas**, clique no botão **⚙**
   (ao lado de Relatórios), cole a sua chave de API e use **Salvar e testar chave**.

Atualizações chegam sozinhas pelo mesmo link. Chave da Anthropic: criar dentro de um
workspace (Console > API keys). Se aparecer "not scoped to a workspace", preencha o
campo Workspace no ⚙.

## Usar

Na tela de Notas clínicas, com a lista de evoluções do paciente aberta (fora do modo
de edição):

1. **Relatorio IA** → OK. O script lê sozinho as notas de médico mais recentes
   (10 por padrão; enfermagem, farmácia etc. ficam de fora, sem precisar do filtro
   do Tasy) e manda só data e texto à IA.
2. O relatório aparece numa janela e **já está copiado**.
3. Clique no nome do paciente (canto superior direito) → **Atestado** → Ctrl+V.
   Revise, corrija e assine: é um rascunho.

Outros botões: **Resumo IA** (resumo do caso para colar no topo da evolução, em
seções # Histórico, # Resumo oncológico, # Exames relevantes, # HD), **Copiar + TXT**
(todas as evoluções visíveis, com data), **Baixar XLS** (o Exportar XLS nativo em
cada nota).

## Privacidade

A chave da API fica só no Tampermonkey do navegador; não há servidor no meio. À IA vão
apenas data e texto das notas: identificação do paciente, nome do profissional e
linhas `#ID` dentro da nota são removidas antes do envio. Provedores: Claude (padrão
testado, `claude-sonnet-5-5`), OpenAI ou Gemini. O texto gerado contém dados clínicos:
tratar como prontuário. Nenhum dado de paciente entra neste repositório.

`exportar-evolucoes-tampermonkey.user.js` é a versão anterior (só copiar/XLS), mantida
como referência. Não ativar os dois ao mesmo tempo. O script roda só em
`tasy.hospitaldeamor.com.br`; para outro Tasy, ajustar o `@match`.
