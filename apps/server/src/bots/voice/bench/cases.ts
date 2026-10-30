/**
 * The scripted runs `voiceBench.ts` scores. Replies are pt-BR, the language production speaks, in
 * the shapes bots send: plain prose, lists, markdown with code and links, and a reply long enough
 * to be spoken in parts. `conv-story` is the reply and request from the voice regression of
 * 2026-10-29, where the voice summarized the reply.
 */

export interface BenchTurn {
  /** What the user says, synthesized once and played into the microphone. None: the reply just arrives. */
  readonly user?: string;
  /** The bot's reply, as the thread would store it. */
  readonly reply: string;
  /** How long the bot works on the user's message before the reply arrives. */
  readonly botDelayMs?: number;
}

export interface BenchCase {
  readonly name: string;
  readonly mode: "read" | "conversation";
  readonly turns: ReadonlyArray<BenchTurn>;
}

const PLAIN = `Olhei a previsão para amanhã em Florianópolis. De manhã o céu fica nublado, com mínima de dezessete graus, e a chuva começa por volta das onze horas, fraca no começo. À tarde ela aperta, com chance de oitenta por cento e vento sul de até trinta quilômetros por hora, então a praia não vale a pena. A máxima fica em vinte e dois graus. No fim da tarde o tempo abre um pouco, mas a umidade continua alta até a noite. Se você for sair para correr, o melhor horário é antes das dez. Para a viagem de sábado, a previsão ainda muda bastante: hoje o modelo mostra sol entre nuvens e máxima de vinte e cinco graus, mas eu confirmo de novo na sexta de manhã e te aviso se mudar.`;

const LIST = `Mandei para o seu pai a história do descobrimento do Brasil, em uma mensagem só. O WhatsApp confirmou o envio. Escrevi em primeira pessoa, como se fosse você, então ele vai ler como mensagem sua.

Resumo do que contei:
- A frota de 13 navios saiu de Lisboa em 9/3/1500, comandada por Cabral, rumo à Índia.
- Avistaram o Monte Pascoal, na Bahia, em 22/4/1500.
- Houve contato pacífico com os povos indígenas, a primeira missa em 26/4 e a carta de Pero Vaz de Caminha ao rei.
- A terra foi chamada de Vera Cruz, e o nome "Brasil" veio depois, do pau-brasil.
- Citei a dúvida dos historiadores se o achado foi acidente ou intencional.

Não vi se ele já leu nem se respondeu.`;

const MARKDOWN = `Achei o problema do deploy. O **build** passa, mas o servidor não sobe porque falta a variável \`DATABASE_URL\` no ambiente de produção. O log mostra o erro logo na primeira linha:

\`\`\`
Error: DATABASE_URL is not set
    at loadConfig (src/config.ts:42:11)
\`\`\`

A documentação do provedor explica como configurar em [variáveis de ambiente](https://docs.example.com/deploy/env-vars). Depois de definir a variável, basta rodar \`pnpm run deploy\` de novo.

Quer que eu configure a variável com o valor do cofre e faça o deploy?`;

const LONG = `Fechei a revisão da semana do projeto do aplicativo de entregas. Vou por partes, começando pelo que já está pronto.

A tela de pedidos ficou pronta na terça. Ela agora mostra o status de cada entrega em tempo real, com o nome do entregador e a previsão de chegada. Testei com vinte pedidos ao mesmo tempo e a lista continuou rápida, sem travar no celular mais antigo que temos para teste. O cliente aprovou o visual na reunião de quarta, com só um pedido: aumentar o tamanho do botão de cancelar, que hoje fica pequeno demais para o dedo.

O pagamento por Pix também entrou. O código aparece na tela assim que o pedido é confirmado, e o aplicativo detecta o pagamento sozinho em poucos segundos. Ainda falta o reembolso automático quando um pedido é cancelado depois de pago. Hoje isso é feito à mão pelo financeiro, e eles pediram para resolver antes do lançamento.

Agora o que ainda está aberto.
- O mapa de rotas consome bateria demais quando fica aberto por mais de meia hora. Já sei que a causa é a atualização da localização a cada segundo; vou trocar para a cada dez segundos e medir de novo.
- As notificações não chegam em alguns celulares com o modo de economia de energia ligado. Isso depende de uma configuração do sistema, então vou escrever um aviso para o usuário ativar a permissão.
- A tradução para o espanhol está pela metade. Faltam as telas de cadastro e de ajuda, umas quarenta frases no total.

Sobre o cronograma, o lançamento continua marcado para o dia quinze do mês que vem. Se o reembolso automático ficar pronto até a próxima sexta, sobram dez dias para testes com usuários reais, o que é o mínimo que eu considero seguro. Se atrasar, eu sugiro lançar primeiro só em uma cidade e abrir para as outras uma semana depois.

Por fim, o orçamento. Gastamos até agora setenta por cento do previsto, e o que resta cobre o trabalho planejado com uma folga pequena. O maior risco de estourar é o servidor de mapas, que cobra por consulta; com o volume que esperamos no lançamento, a conta deve dobrar no primeiro mês.

Preciso de uma decisão sua: lançamos em todas as cidades no dia quinze, mesmo sem o reembolso automático, ou começamos só por uma cidade?`;

const SHORT_ANSWER = `Sete vezes oito dá cinquenta e seis. Se quiser, eu te mando a tabuada do sete inteira por mensagem.`;

export const CASES: ReadonlyArray<BenchCase> = [
  { name: "read-plain", mode: "read", turns: [{ reply: PLAIN }] },
  { name: "read-list", mode: "read", turns: [{ reply: LIST }] },
  { name: "read-markdown", mode: "read", turns: [{ reply: MARKDOWN }] },
  { name: "read-long", mode: "read", turns: [{ reply: LONG }] },
  {
    name: "conv-story",
    mode: "conversation",
    turns: [
      {
        user: "Conta a história do descobrimento do Brasil pro meu pai, manda pra ele no WhatsApp.",
        reply: LIST,
        botDelayMs: 15_000,
      },
    ],
  },
  {
    name: "conv-math",
    mode: "conversation",
    turns: [{ user: "Quanto é sete vezes oito?", reply: SHORT_ANSWER, botDelayMs: 8_000 }],
  },
  {
    name: "conv-plain",
    mode: "conversation",
    turns: [
      {
        user: "Como vai estar o tempo amanhã em Florianópolis?",
        reply: PLAIN,
        botDelayMs: 12_000,
      },
    ],
  },
];
