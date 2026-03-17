const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const Anthropic = require('@anthropic-ai/sdk');

dotenv.config();

const app = express();

// Middlewares
app.use(cors());
app.use(express.json());

// Conectar ao MongoDB
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ MongoDB conectado!'))
  .catch((err) => console.log('❌ Erro MongoDB:', err));

// Schema de Análise
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

// Inicializar cliente Anthropic
const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

// ============ ROTAS ============

// 1. Analisar texto
app.post('/api/analisar', async (req, res) => {
  try {
    const { texto } = req.body;

    if (!texto || texto.trim().length < 20) {
      return res.status(400).json({
        erro: 'O texto deve ter pelo menos 20 caracteres.'
      });
    }

    console.log('📝 Analisando texto...');

    const message = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1000,
      messages: [
        {
          role: 'user',
          content: `Você é um especialista em análise de desinformação. Analise o texto e identifique possíveis sinais de fake news.

Responda APENAS em JSON válido, sem nenhum texto adicional:
{
  "risco": "baixo|médio|alto",
  "percentualRisco": número entre 0 e 100,
  "sinais": ["sinal1", "sinal2", ...],
  "explicacao": "explicação clara",
  "recomendacao": "recomendação"
}

Considere: títulos sensacionalistas, falta de fontes, linguagem emocional, afirmações absolutas, pedidos para compartilhar, erros gramaticais.

Texto:
"${texto}"`
        }
      ]
    });

    const textoResposta = message?.content?.[0]?.text || '';
    console.log('📥 Resposta bruta da IA:', textoResposta);

    let resultado;

    try {
      resultado = JSON.parse(textoResposta);
    } catch (e) {
      const jsonMatch = textoResposta.match(/\{[\s\S]*\}/);

      if (!jsonMatch) {
        throw new Error('A IA não retornou JSON válido.');
      }

      resultado = JSON.parse(jsonMatch[0]);
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
    console.log('✅ Análise salva!');

    res.json({
      sucesso: true,
      id: analise._id,
      ...resultado
    });

  } catch (error) {
    console.error('❌ Erro ao analisar:');
    console.error('status:', error?.status);
    console.error('message:', error?.message);
    console.error('type:', error?.type);
    console.error('full error:', error);

    res.status(500).json({
      erro: error?.message || 'Erro ao analisar texto.'
    });
  }
});

// 2. Enviar feedback
app.post('/api/feedback/:id', async (req, res) => {
  try {
    const { avaliacaoCorreta, observacoes } = req.body;
    const { id } = req.params;

    const analise = await Analise.findByIdAndUpdate(
      id,
      {
        feedback: {
          avaliacaoCorreta,
          observacoes,
          dataFeedback: new Date()
        }
      },
      { new: true }
    );

    if (!analise) {
      return res.status(404).json({ erro: 'Análise não encontrada.' });
    }

    console.log('✅ Feedback salvo!');
    res.json({ sucesso: true, analise });

  } catch (error) {
    console.error('❌ Erro ao salvar feedback:', error);
    res.status(500).json({ erro: 'Erro ao salvar feedback.' });
  }
});

// 3. Obter estatísticas
app.get('/api/estatisticas', async (req, res) => {
  try {
    const totalAnalises = await Analise.countDocuments();

    const analisesPorRisco = await Analise.aggregate([
      {
        $group: {
          _id: '$risco',
          quantidade: { $sum: 1 }
        }
      }
    ]);

    const analisesComFeedback = await Analise.countDocuments({
      'feedback.avaliacaoCorreta': { $exists: true }
    });

    const feedbackCorretos = await Analise.countDocuments({
      'feedback.avaliacaoCorreta': true
    });

    const taxaAcerto = analisesComFeedback > 0
      ? ((feedbackCorretos / analisesComFeedback) * 100).toFixed(2)
      : 0;

    const analises = await Analise.find()
      .sort({ dataAnalise: -1 })
      .limit(100);

    res.json({
      totalAnalises,
      analisesComFeedback,
      feedbackCorretos,
      taxaAcerto: parseFloat(taxaAcerto),
      porRisco: analisesPorRisco,
      ultimas: analises
    });

  } catch (error) {
    console.error('❌ Erro ao obter estatísticas:', error);
    res.status(500).json({ erro: 'Erro ao obter estatísticas.' });
  }
});

// 4. Obter análise específica
app.get('/api/analise/:id', async (req, res) => {
  try {
    const analise = await Analise.findById(req.params.id);

    if (!analise) {
      return res.status(404).json({ erro: 'Análise não encontrada.' });
    }

    res.json(analise);

  } catch (error) {
    console.error('❌ Erro ao obter análise:', error);
    res.status(500).json({ erro: 'Erro ao obter análise.' });
  }
});

// 5. Listar todas as análises
app.get('/api/analises', async (req, res) => {
  try {
    const analises = await Analise.find()
      .sort({ dataAnalise: -1 });

    res.json(analises);

  } catch (error) {
    console.error('❌ Erro ao listar análises:', error);
    res.status(500).json({ erro: 'Erro ao listar análises.' });
  }
});

// Servir arquivos estáticos
app.use(express.static('public'));

// Rota raiz
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/index.html');
});

// Iniciar servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando em http://localhost:${PORT}`);
});
