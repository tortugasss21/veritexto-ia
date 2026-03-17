const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const OpenAI = require('openai');

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());

// ===================== MONGODB =====================
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ MongoDB conectado!'))
  .catch((err) => console.log('❌ Erro MongoDB:', err));

// ===================== SCHEMA =====================
const analiseSchema = new mongoose.Schema({
  texto: String,
  risco: String,
  percentualRisco: Number,
  sinais: [String],
  explicacao: String,
  recomendacao: String,
  dataAnalise: { type: Date, default: Date.now }
});

const Analise = mongoose.model('Analise', analiseSchema);

// ===================== OPENROUTER =====================
const client = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: 'https://openrouter.ai/api/v1'
});

// ===================== LOGIN =====================
app.post('/api/login', (req, res) => {
  const { user, pass } = req.body;

  if (user === 'adm' && pass === 'adm') {
    return res.json({ sucesso: true, token: 'admin-logado' });
  }

  res.status(401).json({ erro: 'Login inválido' });
});

// ===================== PROTEÇÃO =====================
function verificarAdmin(req, res, next) {
  const token = req.headers.authorization;

  if (token === 'admin-logado') {
    next();
  } else {
    res.status(403).json({ erro: 'Acesso negado' });
  }
}

// ===================== ANALISAR =====================
app.post('/api/analisar', async (req, res) => {
  try {
    const { texto } = req.body;

    if (!texto || texto.length < 20) {
      return res.status(400).json({ erro: 'Texto muito curto' });
    }

    console.log('📝 Analisando...');

    const completion = await client.chat.completions.create({
      model: 'openrouter/free',
      messages: [
        {
          role: 'system',
          content: 'Você é especialista em fake news. Responda apenas JSON.'
        },
        {
          role: 'user',
          content: `Analise:

"${texto}"

Formato:
{
 "risco":"baixo|medio|alto",
 "percentualRisco":0-100,
 "sinais":["..."],
 "explicacao":"...",
 "recomendacao":"..."
}`
        }
      ]
    });

    let resposta = completion.choices[0].message.content;

    let resultado;

    try {
      resultado = JSON.parse(resposta);
    } catch {
      const match = resposta.match(/\{[\s\S]*\}/);
      resultado = match ? JSON.parse(match[0]) : {
        risco: 'medio',
        percentualRisco: 50,
        sinais: ['Erro ao interpretar resposta'],
        explicacao: 'Resposta fora do padrão',
        recomendacao: 'Tente novamente'
      };
    }

    const analise = new Analise(resultado);
    await analise.save();

    res.json(resultado);

  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: 'Erro na análise' });
  }
});

// ===================== ADMIN =====================
app.get('/api/admin/analises', verificarAdmin, async (req, res) => {
  const analises = await Analise.find().sort({ dataAnalise: -1 });
  res.json(analises);
});

app.get('/api/admin/estatisticas', verificarAdmin, async (req, res) => {
  const total = await Analise.countDocuments();

  const porRisco = await Analise.aggregate([
    { $group: { _id: '$risco', quantidade: { $sum: 1 } } }
  ]);

  res.json({ totalAnalises: total, porRisco });
});

// ===================== FRONT =====================
app.use(express.static('public'));

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/index.html');
});

// ===================== START =====================
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 Rodando na porta ${PORT}`);
});
