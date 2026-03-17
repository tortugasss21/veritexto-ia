const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const OpenAI = require('openai');

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());

// MongoDB
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ MongoDB conectado!'))
  .catch((err) => console.log('❌ Erro MongoDB:', err));

// Schema
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

// OpenRouter (usa SDK da OpenAI)
const client = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: 'https://openrouter.ai/api/v1'
});

// ================== ANALISAR ==================
app.post('/api/analisar', async (req, res) => {
  try {
    const { texto } = req.body;

    if (!texto || texto.trim().length < 20) {
      return res.status(400).json({
        erro: 'O texto deve ter pelo menos 20 caracteres.'
      });
    }

    console.log('📝 Analisando texto...');

    const completion = await client.chat.completions.create({
      model: 'openrouter/free',
      messages: [
        {
          role: 'system',
          content: 'Você é um especialista em fake news. Responda apenas em JSON válido.'
        },
        {
          role: 'user',
          content: `Analise este texto:

"${texto}"

Responda exatamente neste formato JSON:
{
  "risco": "baixo|medio|alto",
  "percentualRisco": 0-100,
  "sinais": ["..."],
  "explicacao": "...",
  "recomendacao": "..."
}`
        }
      ]
    });

    const resposta = completion.choices[0].message.content;
    console.log('📥 IA respondeu:', resposta);

    let resultado;

    try {
      resultado = JSON.parse(resposta);
    } catch {
      const match = resposta.match(/\{[\s\S]*\}/);
      if (!match) throw new Error('Resposta inválida da IA');
      resultado = JSON.parse(match[0]);
    }

    const analise = new Analise({
      texto,
      risco: resultado.risco,
      percentualRisco: resultado.percentualRisco,
      sinais: resultado.sinais,
      explicacao: resultado.explicacao,
      recomendacao: resultado.recomendacao
    });

    await analise.save();

    res.json({
      sucesso: true,
      id: analise._id,
      ...resultado
    });

  } catch (error) {
    console.error('❌ Erro:', error);

    res.status(500).json({
      erro: error.message || 'Erro ao analisar'
    });
  }
});

// ================== TESTE ==================
app.get('/api/teste', (req, res) => {
  res.json({ ok: true });
});

// ================== SERVER ==================
app.use(express.static('public'));

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/index.html');
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 Rodando em http://localhost:${PORT}`);
});
