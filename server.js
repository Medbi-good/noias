// Backend do NOIAS — feed de memes.
// Node/Express + PostgreSQL, pensado para correr no Render (padrão MEDBI).

const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;
const REPORT_THRESHOLD = 3; // nº de denúncias antes de esconder automaticamente

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost')
    ? false
    : { rejectUnauthorized: false }
});

app.use(cors()); // aberto por agora — o app corre dentro de um APK, não de um browser com origem fixa
app.use(express.json({ limit: '8mb' })); // imagens dos memes vêm como dataURL base64

const CATEGORIAS_VALIDAS = ['Política', 'Futebol', 'Escola', 'Dia-a-dia', 'Relacionamentos', 'Trabalho', 'Outros'];

// Trava simples para as rotas /api/admin — define ADMIN_KEY nas
// Environment Variables do Render. Sem essa variável definida, as
// rotas admin ficam bloqueadas por segurança (falha fechada).
function requireAdminKey(req, res, next) {
  const expected = process.env.ADMIN_KEY;
  if (!expected) return res.status(503).json({ error: 'ADMIN_KEY não configurada no servidor' });
  const given = req.get('x-admin-key');
  if (given !== expected) return res.status(401).json({ error: 'Não autorizado' });
  next();
}

app.get('/api/health', (req, res) => res.json({ ok: true }));

// ---------- LISTAR FEED ----------
// GET /api/memes?categoria=Futebol&limit=30&offset=0&device_id=abc123
app.get('/api/memes', async (req, res) => {
  try {
    const { categoria, device_id } = req.query;
    const limit = Math.min(parseInt(req.query.limit) || 30, 100);
    const offset = parseInt(req.query.offset) || 0;

    const params = [];
    let where = 'WHERE visivel = TRUE AND banido = FALSE';
    if (categoria && categoria !== 'Todos') {
      params.push(categoria);
      where += ` AND categoria = $${params.length}`;
    }

    params.push(limit, offset);
    const { rows } = await pool.query(
      `SELECT id, autor, categoria, imagem_data, top_text, bottom_text,
              likes_count, comentarios_count, criado_em
       FROM memes
       ${where}
       ORDER BY criado_em DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    if (device_id && rows.length) {
      const ids = rows.map(r => r.id);
      const liked = await pool.query(
        `SELECT meme_id FROM likes WHERE device_id = $1 AND meme_id = ANY($2::int[])`,
        [device_id, ids]
      );
      const likedSet = new Set(liked.rows.map(r => r.meme_id));
      rows.forEach(r => { r.liked_by_me = likedSet.has(r.id); });
    }

    res.json(rows);
  } catch (err) {
    console.error('GET /api/memes', err);
    res.status(500).json({ error: 'Erro ao carregar o feed' });
  }
});

// ---------- PUBLICAR MEME ----------
// POST /api/memes { autor, categoria, imagem_data, top_text, bottom_text }
app.post('/api/memes', async (req, res) => {
  try {
    const { autor, categoria, imagem_data, top_text, bottom_text } = req.body;

    if (!imagem_data) return res.status(400).json({ error: 'imagem_data em falta' });
    if (!CATEGORIAS_VALIDAS.includes(categoria)) {
      return res.status(400).json({ error: 'Categoria inválida' });
    }

    const { rows } = await pool.query(
      `INSERT INTO memes (autor, categoria, imagem_data, top_text, bottom_text)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, autor, categoria, imagem_data, top_text, bottom_text,
                 likes_count, comentarios_count, criado_em`,
      [(autor || 'Anónimu').slice(0, 40), categoria, imagem_data, (top_text || '').slice(0, 60), (bottom_text || '').slice(0, 60)]
    );

    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('POST /api/memes', err);
    res.status(500).json({ error: 'Erro ao publicar o meme' });
  }
});

// ---------- LIKE (toggle por device_id) ----------
// POST /api/memes/:id/like { device_id }
app.post('/api/memes/:id/like', async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { device_id } = req.body;
    if (!device_id) return res.status(400).json({ error: 'device_id em falta' });

    await client.query('BEGIN');
    const existing = await client.query(
      'SELECT id FROM likes WHERE meme_id = $1 AND device_id = $2',
      [id, device_id]
    );

    let liked;
    if (existing.rows.length) {
      await client.query('DELETE FROM likes WHERE id = $1', [existing.rows[0].id]);
      await client.query('UPDATE memes SET likes_count = GREATEST(likes_count - 1, 0) WHERE id = $1', [id]);
      liked = false;
    } else {
      await client.query('INSERT INTO likes (meme_id, device_id) VALUES ($1, $2)', [id, device_id]);
      await client.query('UPDATE memes SET likes_count = likes_count + 1 WHERE id = $1', [id]);
      liked = true;
    }

    const { rows } = await client.query('SELECT likes_count FROM memes WHERE id = $1', [id]);
    await client.query('COMMIT');
    res.json({ liked, likes_count: rows[0]?.likes_count ?? 0 });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /api/memes/:id/like', err);
    res.status(500).json({ error: 'Erro ao registar like' });
  } finally {
    client.release();
  }
});

// ---------- DENUNCIAR ----------
// POST /api/memes/:id/report { device_id }
app.post('/api/memes/:id/report', async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { device_id } = req.body;

    await client.query('BEGIN');
    await client.query('INSERT INTO reports (meme_id, device_id) VALUES ($1, $2)', [id, device_id || null]);
    const upd = await client.query(
      'UPDATE memes SET denuncias_count = denuncias_count + 1 WHERE id = $1 RETURNING denuncias_count',
      [id]
    );

    let hidden = false;
    if (upd.rows[0] && upd.rows[0].denuncias_count >= REPORT_THRESHOLD) {
      await client.query('UPDATE memes SET visivel = FALSE WHERE id = $1', [id]);
      hidden = true;
    }

    await client.query('COMMIT');
    res.json({ denuncias_count: upd.rows[0]?.denuncias_count ?? 0, hidden });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /api/memes/:id/report', err);
    res.status(500).json({ error: 'Erro ao denunciar' });
  } finally {
    client.release();
  }
});

// ---------- ADMIN (protegido por chave — ver requireAdminKey acima) ----------
// Lista memes escondidos/denunciados para revisão manual.
app.get('/api/admin/reported', requireAdminKey, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, autor, categoria, imagem_data, denuncias_count, visivel, criado_em
       FROM memes WHERE denuncias_count > 0 ORDER BY denuncias_count DESC`
    );
    res.json(rows);
  } catch (err) {
    console.error('GET /api/admin/reported', err);
    res.status(500).json({ error: 'Erro ao carregar denúncias' });
  }
});

// POST /api/admin/memes/:id/ban  — remove definitivamente do feed
app.post('/api/admin/memes/:id/ban', requireAdminKey, async (req, res) => {
  try {
    await pool.query('UPDATE memes SET banido = TRUE, visivel = FALSE WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/admin/memes/:id/ban', err);
    res.status(500).json({ error: 'Erro ao banir meme' });
  }
});

// POST /api/admin/memes/:id/restore — repõe no feed (falso positivo de denúncia)
app.post('/api/admin/memes/:id/restore', requireAdminKey, async (req, res) => {
  try {
    await pool.query('UPDATE memes SET visivel = TRUE, denuncias_count = 0 WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/admin/memes/:id/restore', err);
    res.status(500).json({ error: 'Erro ao restaurar meme' });
  }
});

app.listen(PORT, () => console.log(`NOIAS backend a correr na porta ${PORT}`));
