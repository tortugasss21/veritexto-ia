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
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
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
      model: 'claude-opus-4-20250805',
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

    let resultado;
    try {
      const texto_resposta = message.content[0].text;
      resultado = JSON.parse(texto_resposta);
    } catch (e) {
      const jsonMatch = message.content[0].text.match(/\{[\s\S]*\}/);
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
    console.error('❌ Erro ao analisar:', error);
    res.status(500).json({ 
      erro: 'Erro ao analisar texto. Verifique sua chave API.' 
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
```

4. Clique em **"Commit changes"**

---

## 🌐 **PASSO 7: Criar Arquivo `.env`**

1. Clique em **"Add file"** > **"Create new file"**
2. Nome: `.env` (começa com ponto!)
3. Cole isto **COM SUAS CHAVES REAIS**:
```
MONGODB_URI=mongodb+srv://eduardobartzz2008_db_user:alorkaexHkoV2UM0@veritexto-ia.qyfjofrr.mongodb.net/?appName=veritexto-ia
ANTHROPIC_API_KEY=sk-ant-v1-sua-chave-da-claude-aqui
PORT=3000
```

⚠️ **Substitua:**
- A string do MongoDB (copie de antes)
- A chave Claude API

4. Clique em **"Commit changes"**

---

## 📁 **PASSO 8: Criar Pasta e Arquivo `public/index.html`**

1. Clique em **"Add file"** > **"Create new file"**
2. Nome: `public/index.html` **(com a barra!)**
3. Cole o código do `index.html` (vou dar logo)
4. Clique em **"Commit changes"**

---

## ✅ **Pronto!**

Depois desses passos, seu repositório terá:
```
veritexto-ia/
├── 📄 README.md
├── 📄 package.json
├── 🔧 server.js
├── 🔐 .env
└── 📁 public/
    └── 🌐 index.html
