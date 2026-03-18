const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const OpenAI = require('openai');

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());

// ===================== RATE LIMITING =====================
const requestCounts = new Map();
const RATE_LIMIT = 10;
const RATE_WINDOW = 60 * 1000;

function rateLimit(req, res, next) {
  const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown';
  const now = Date.now();
  const entry = requestCounts.get(ip);

  if (!entry || now - entry.start > RATE_WINDOW) {
    requestCounts.set(ip, { count: 1, start: now });
    return next();
  }

  if (entry.count >= RATE_LIMIT) {
    return res.status(429).json({ erro: 'Muitas requisições. Aguarde um minuto.' });
  }

  entry.count++;
  next();
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of requestCounts.entries()) {
    if (now - entry.start > RATE_WINDOW) requestCounts.delete(ip);
  }
}, 5 * 60 * 1000);

// ===================== MONGODB =====================
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('MongoDB conectado.'))
  .catch((err) => console.error('Erro MongoDB:', err));

// ===================== SCHEMA =====================
const analiseSchema = new mongoose.Schema({
  texto: String,
  risco: String,
  percentualRisco: Number,
  sinais: [String],
  explicacao: String,
  recomendacao: String,
  dataAnalise: { type: Date, default: Date.now },
  feedback: {
    avaliacaoCorreta: Boolean,
    observacoes: String,
    dataFeedback: Date
  }
});

const Analise = mongoose.model('Analise', analiseSchema);

// ===================== OPENROUTER =====================
const client = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: 'https://openrouter.ai/api/v1'
});

const AI_MODEL = process.env.AI_MODEL || 'openrouter/free';

// ===================== FUNÇÕES AUXILIARES =====================
function limparJsonString(texto) {
  if (!texto) return '';
  return texto
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim();
}

function normalizarRisco(risco) {
  if (!risco) return 'medio';
  const texto = String(risco)
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  if (texto === 'baixo' || texto === 'low') return 'baixo';
  if (texto === 'medio' || texto === 'medium' || texto === 'med io') return 'medio';
  if (texto === 'alto' || texto === 'high') return 'alto';
  return 'medio';
}

function normalizarResultado(resultado, textoOriginal = '') {
  const risco = normalizarRisco(resultado?.risco);

  let percentualRisco = Number(resultado?.percentualRisco);
  if (Number.isNaN(percentualRisco) || !Number.isFinite(percentualRisco)) {
    percentualRisco = risco === 'alto' ? 85 : risco === 'medio' ? 55 : 20;
  }
  percentualRisco = Math.max(0, Math.min(100, Math.round(percentualRisco)));

  const sinais = Array.isArray(resultado?.sinais)
    ? resultado.sinais.map(s => String(s).trim()).filter(Boolean)
    : [];

  const explicacao = resultado?.explicacao
    ? String(resultado.explicacao).trim()
    : 'A análise identificou possíveis sinais no texto, mas a explicação detalhada não foi retornada corretamente.';

  const recomendacao = resultado?.recomendacao
    ? String(resultado.recomendacao).trim()
    : 'Verifique a informação em fontes confiáveis antes de compartilhar.';

  return { texto: textoOriginal, risco, percentualRisco, sinais, explicacao, recomendacao };
}

function criarResultadoFallback(textoOriginal = '') {
  return {
    texto: textoOriginal,
    risco: 'medio',
    percentualRisco: 50,
    sinais: ['A resposta da IA não veio em formato ideal'],
    explicacao: 'O sistema não conseguiu interpretar a resposta da IA. Foi gerado um resultado de segurança.',
    recomendacao: 'Tente novamente e verifique a informação em fontes confiáveis antes de compartilhar.'
  };
}

function extrairResultadoDaResposta(resposta, textoOriginal = '') {
  const textoLimpo = limparJsonString(resposta);
  if (!textoLimpo) return criarResultadoFallback(textoOriginal);

  try {
    const jsonDireto = JSON.parse(textoLimpo);
    if (jsonDireto && typeof jsonDireto === 'object') {
      return normalizarResultado(jsonDireto, textoOriginal);
    }
  } catch (_) {}

  const match = textoLimpo.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const jsonExtraido = JSON.parse(match[0]);
      if (jsonExtraido && typeof jsonExtraido === 'object') {
        return normalizarResultado(jsonExtraido, textoOriginal);
      }
    } catch (_) {}
  }

  return criarResultadoFallback(textoOriginal);
}

// ===================== ROTAS =====================

app.get('/api/teste', (req, res) => {
  res.json({ ok: true, mensagem: 'API funcionando!' });
});

// ANALISAR TEXTO
app.post('/api/analisar', rateLimit, async (req, res) => {
  try {
    const { texto } = req.body;

    if (!texto || texto.trim().length < 20) {
      return res.status(400).json({ erro: 'O texto deve ter pelo menos 20 caracteres.' });
    }

    console.log('Analisando texto...');

    const dataHoje = new Date().toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });

    const completion = await client.chat.completions.create({
      model: AI_MODEL,
      messages: [
        {
          role: 'system',
          content: `Você é um especialista em verificação de fatos e análise de desinformação. Responda somente em JSON válido.

A data de hoje é ${dataHoje}. Qualquer data anterior a hoje é passada — nunca a trate como "data futura".

Ao analisar um texto, avalie os seguintes critérios objetivamente:
- Linguagem alarmista, sensacionalista ou apelos emocionais excessivos ("URGENTE!", "compartilhe antes que apaguem")
- Ausência de fontes concretas, nomes de especialistas ou instituições verificáveis
- Afirmações absolutas sem evidências ("cientistas provaram", "o governo esconde")
- Inconsistências internas ou dados que contradizem fatos conhecidos
- Contexto manipulado (imagem/fato real usado fora de contexto)
- Erros gramaticais excessivos ou formatação típica de spam

Textos com fontes verificáveis, linguagem neutra e dados concretos devem ter risco BAIXO, mesmo que o assunto seja polêmico.
Não invente sinais que não estão presentes no texto.`
        },
        {
          role: 'user',
          content: `Analise este texto e retorne JSON:
"URGENTE!! Vacinas causam autismo, estudo secreto do governo prova! Compartilhe antes que apaguem essa verdade!"`
        },
        {
          role: 'assistant',
          content: `{"risco":"alto","percentualRisco":92,"sinais":["Linguagem alarmista: 'URGENTE!!' e apelo para compartilhar","Alegação de 'estudo secreto' sem fonte verificável","Afirmação científica falsa amplamente refutada","Pressão emocional para viralizar antes de 'apagar'"],"explicacao":"O texto usa múltiplos marcadores clássicos de desinformação: urgência artificial, teoria conspiratória de supressão governamental e uma afirmação médica falsa. A relação vacinas-autismo foi amplamente estudada e refutada pela comunidade científica.","recomendacao":"Não compartilhe. Consulte fontes como OMS, Fiocruz ou Ministério da Saúde para informações sobre vacinas."}`
        },
        {
          role: 'user',
          content: `Analise este texto e retorne JSON:
"Segundo relatório divulgado pelo IBGE em março de 2025, o Brasil registrou crescimento de 2,1% no PIB no último trimestre, impulsionado pelo setor agrícola."`
        },
        {
          role: 'assistant',
          content: `{"risco":"baixo","percentualRisco":8,"sinais":[],"explicacao":"O texto cita uma fonte verificável (IBGE), apresenta dados específicos (2,1%), indica período (março de 2025) e setor responsável. A linguagem é neutra e informativa, sem apelos emocionais ou afirmações absolutas.","recomendacao":"O texto apresenta características de informação jornalística confiável. Você pode verificar diretamente no site do IBGE para confirmar os dados."}`
        },
        {
          role: 'user',
          content: `Analise este texto e retorne JSON. Responda APENAS com o JSON, sem markdown, sem crases e sem texto extra.

Texto:
"${texto}"`
        }
      ]
    });

    const respostaBruta = completion?.choices?.[0]?.message?.content || '';
    console.log('Resposta bruta da IA:', respostaBruta);

    const resultadoFinal = extrairResultadoDaResposta(respostaBruta, texto);

    // Gera o ID antes de salvar para poder retornar ao frontend
    const analiseId = new mongoose.Types.ObjectId();
    const analise = new Analise({
      _id: analiseId,
      texto: resultadoFinal.texto,
      risco: resultadoFinal.risco,
      percentualRisco: resultadoFinal.percentualRisco,
      sinais: resultadoFinal.sinais,
      explicacao: resultadoFinal.explicacao,
      recomendacao: resultadoFinal.recomendacao
    });

    res.json({
      sucesso: true,
      id: analiseId,
      risco: resultadoFinal.risco,
      percentualRisco: resultadoFinal.percentualRisco,
      sinais: resultadoFinal.sinais,
      explicacao: resultadoFinal.explicacao,
      recomendacao: resultadoFinal.recomendacao
    });

    analise.save()
      .then((doc) => console.log('Análise salva. id:', doc._id))
      .catch((err) => console.error('Erro ao salvar análise:', err));

  } catch (error) {
    console.error('Erro ao analisar:', error?.message);
    if (!res.headersSent) {
      res.status(500).json({ erro: error?.message || 'Erro ao analisar texto.' });
    }
  }
});

// ENVIAR FEEDBACK
app.post('/api/feedback/:id', async (req, res) => {
  try {
    const { avaliacaoCorreta, observacoes } = req.body;
    const { id } = req.params;

    if (typeof avaliacaoCorreta !== 'boolean') {
      return res.status(400).json({ erro: 'avaliacaoCorreta deve ser true ou false.' });
    }

    const analise = await Analise.findByIdAndUpdate(
      id,
      { feedback: { avaliacaoCorreta, observacoes: observacoes || '', dataFeedback: new Date() } },
      { new: true }
    );

    if (!analise) {
      return res.status(404).json({ erro: 'Análise não encontrada.' });
    }

    console.log('Feedback salvo. id:', id);
    res.json({ sucesso: true });

  } catch (error) {
    console.error('Erro ao salvar feedback:', error);
    res.status(500).json({ erro: 'Erro ao salvar feedback.' });
  }
});

// ESTATÍSTICAS
app.get('/api/estatisticas', async (req, res) => {
  try {
    const totalAnalises = await Analise.countDocuments();

    const analisesPorRisco = await Analise.aggregate([
      { $group: { _id: '$risco', quantidade: { $sum: 1 } } }
    ]);

    const analisesComFeedback = await Analise.countDocuments({
      'feedback.avaliacaoCorreta': { $exists: true }
    });

    const feedbackCorretos = await Analise.countDocuments({
      'feedback.avaliacaoCorreta': true
    });

    const taxaAcerto = analisesComFeedback > 0
      ? parseFloat(((feedbackCorretos / analisesComFeedback) * 100).toFixed(2))
      : 0;

    res.json({
      totalAnalises,
      analisesComFeedback,
      feedbackCorretos,
      taxaAcerto,
      porRisco: analisesPorRisco
    });

  } catch (error) {
    console.error('Erro ao obter estatísticas:', error);
    res.status(500).json({ erro: 'Erro ao obter estatísticas.' });
  }
});

// BUSCAR UMA ANÁLISE
app.get('/api/analise/:id', async (req, res) => {
  try {
    const analise = await Analise.findById(req.params.id);
    if (!analise) {
      return res.status(404).json({ erro: 'Análise não encontrada.' });
    }
    res.json(analise);
  } catch (error) {
    console.error('Erro ao obter análise:', error);
    res.status(500).json({ erro: 'Erro ao obter análise.' });
  }
});

// ===================== FRONTEND =====================
app.use(express.static('public'));

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/index.html');
});

// ===================== START =====================
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
});
